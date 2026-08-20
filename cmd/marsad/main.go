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

// parseSystemNamespaces reads the flag, distinguishing three cases that a bare
// slice cannot: unset (use the built-in list), "-" (collapse nothing), and an
// explicit list. Without the middle one there would be no way to say "show me
// everything, always" short of naming every namespace you do not have.
func parseSystemNamespaces(v string) []string {
	switch strings.TrimSpace(v) {
	case "":
		return nil
	case "-":
		return []string{}
	}
	var out []string
	for _, part := range strings.Split(v, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// firstFault prefers whichever failure actually happened first: preflight runs
// before any watch, so if it found something the watch errors are consequences.
func firstFault(preflight, watch *cluster.Fault) *cluster.Fault {
	if preflight != nil {
		return preflight
	}
	return watch
}

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

		// What counts as "system" is a local judgement — a platform team's own
		// namespace is system to the application teams and the whole job to them —
		// so it is configuration rather than a fixed list. An explicitly empty
		// value collapses nothing.
		systemNamespaces = flag.String("system-namespaces", "",
			"comma-separated namespaces to collapse in the graph by default; empty uses the built-in list, \"-\" collapses none")
		ownNamespace = flag.String("namespace", os.Getenv("POD_NAMESPACE"),
			"the namespace Marsad runs in, collapsed along with the system ones")
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
	/*
	 * A cluster Marsad cannot read is a screen, not a crash.
	 *
	 * This used to return, which exits, which in a Deployment is
	 * CrashLoopBackOff — and a pod that never starts shows its error to nobody
	 * except whoever thinks to run `kubectl logs`. Marsad's entire job is to
	 * show you things about your cluster, and "I am not allowed to read your
	 * Deployments, here is the ClusterRole that would fix it" is one of those
	 * things. So the UI comes up either way and says so.
	 */
	fault := cluster.Preflight(clients)
	if fault != nil {
		log.Error("cannot read the cluster",
			"kind", fault.Kind, "host", fault.Host, "error", fault.Message)
	} else {
		log.Info("connected to cluster", "host", clients.Host, "version", cluster.ServerVersion(clients))
	}

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
	if fault == nil {
		go func() { watchErr <- watcher.Run(ctx) }()
	}

	srv := &http.Server{
		Addr: *addr,
		Handler: server.New(server.Options{
			Source:      watcher,
			Log:         log,
			CombineMode: combine,
			DevCORS:     *devCORS,
			Version:     version,
			Fault:       func() *cluster.Fault { return firstFault(fault, watcher.Fault()) },

			SystemNamespaces: parseSystemNamespaces(*systemNamespaces),
			OwnNamespace:     *ownNamespace,
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
			// Same reasoning as the preflight fault: the commonest cause is a
			// token that cannot list something, the watch handler has already
			// recorded the API server's own words, and exiting would replace a
			// screen that explains it with a restart loop that does not.
			log.Error("cluster watch stopped", "error", err)
			if watcher.Fault() == nil {
				fault = cluster.NewFault(err, clients.Host)
			}
			<-ctx.Done()
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
