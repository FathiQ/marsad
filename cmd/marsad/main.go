// Command marsad serves the read-only network policy observatory.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/FathiQ/marsad/internal/server"
	"github.com/FathiQ/marsad/pkg/cluster"
	"github.com/FathiQ/marsad/pkg/npeval"
)

// version is stamped at build time with -ldflags "-X main.version=...".
//
// It has to exist for that to do anything: Go silently discards -X against a
// symbol it cannot find, so the build threaded a version through the Makefile,
// the Dockerfile and CI and dropped it on the floor. Nothing running could say
// what it was, which turned "is this the fixed build?" into guesswork twice.
var version = "dev"

func main() {
	if err := run(); err != nil && !errors.Is(err, context.Canceled) {
		slog.Error("marsad exited", "error", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		addr        = flag.String("addr", ":8080", "address to listen on")
		kubeconfig  = flag.String("kubeconfig", "", "path to a kubeconfig (defaults to in-cluster, then $KUBECONFIG, then ~/.kube/config)")
		logLevel    = flag.String("log-level", "info", "debug, info, warn or error")
		combineMode = flag.String("combine", "intersect",
			"how policy layers from different providers combine: intersect (a pod must satisfy every layer) or union")
		devCORS = flag.Bool("dev-cors", false, "allow cross-origin requests, for running the Vite dev server separately")
	)
	flag.Parse()

	log := newLogger(*logLevel)
	slog.SetDefault(log)

	combine, err := parseCombineMode(*combineMode)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := cluster.RESTConfig(*kubeconfig)
	if err != nil {
		return err
	}
	clients, err := cluster.NewClients(cfg)
	if err != nil {
		return err
	}
	// Fail fast and legibly on bad credentials, rather than letting client-go
	// retry forever while the process looks healthy.
	if err := cluster.Preflight(clients); err != nil {
		return err
	}
	log.Info("connected to cluster", "host", clients.Host, "version", cluster.ServerVersion(clients))

	caps := cluster.Detect(clients.Discovery)
	for _, p := range caps.Policies {
		if p.Available {
			log.Info("policy provider available", "provider", p.Provider)
		} else {
			// Not an error. A non-EKS cluster simply has no domain policies, and
			// the UI says so rather than pretending the graph is complete.
			log.Info("policy provider unavailable", "provider", p.Provider, "reason", p.Reason)
		}
	}

	watcher := cluster.NewWatcher(clients, caps, log)
	watchErr := make(chan error, 1)
	go func() { watchErr <- watcher.Run(ctx) }()

	srv := &http.Server{
		Addr: *addr,
		Handler: server.New(server.Options{
			Source:      watcher,
			Log:         log,
			CombineMode: combine,
			DevCORS:     *devCORS,
			Version:     version,
		}),
		ReadHeaderTimeout: 10 * time.Second,
	}

	serveErr := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", *addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
			return
		}
		serveErr <- nil
	}()

	select {
	case <-ctx.Done():
		log.Info("shutting down")
	case err := <-serveErr:
		return err
	case err := <-watchErr:
		if err != nil && !errors.Is(err, context.Canceled) {
			return fmt.Errorf("cluster watch: %w", err)
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

func parseCombineMode(s string) (npeval.CombineMode, error) {
	switch strings.ToLower(s) {
	case "intersect", "":
		return npeval.CombineIntersect, nil
	case "union":
		return npeval.CombineUnion, nil
	default:
		return 0, fmt.Errorf("unknown -combine %q: use intersect or union", s)
	}
}

func newLogger(level string) *slog.Logger {
	var l slog.Level
	if err := l.UnmarshalText([]byte(level)); err != nil {
		l = slog.LevelInfo
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: l}))
}
