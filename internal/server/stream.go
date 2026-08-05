package server

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/FathiQ/marsad/pkg/graph"
)

// streamMessage is what the client receives on each cluster change.
//
// The whole graph is sent rather than a diff. The graph for a namespace-level
// view is small, the client already has to reconcile node positions on any
// change, and a diff protocol would add a class of desync bug for a saving that
// only matters at a scale the namespace-level default avoids. The debounce in
// the watcher is what actually keeps the message rate sane.
type streamMessage struct {
	Type     string       `json:"type"`
	Revision uint64       `json:"revision"`
	Graph    *graph.Graph `json:"graph,omitempty"`
	Warnings int          `json:"warnings,omitempty"`
	Error    string       `json:"error,omitempty"`
}

const (
	streamWriteTimeout = 10 * time.Second
	streamPingInterval = 30 * time.Second
)

// handleStream pushes a fresh graph whenever the cluster changes.
func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	acceptOpts := &websocket.AcceptOptions{}
	if s.opts.DevCORS {
		acceptOpts.InsecureSkipVerify = true
	}

	conn, err := websocket.Accept(w, r, acceptOpts)
	if err != nil {
		s.log.Warn("stream: accept failed", "error", err, "remote", r.RemoteAddr)
		return
	}
	defer conn.CloseNow() //nolint:errcheck // best effort on teardown

	// Logged at info because a client that keeps reconnecting is a real symptom,
	// and the first place anyone looks is the pod log. It was silent before.
	opened := time.Now()
	s.log.Info("stream: opened", "remote", r.RemoteAddr, "query", r.URL.RawQuery)
	defer func() {
		s.log.Info("stream: closed", "remote", r.RemoteAddr, "lasted", time.Since(opened).Round(time.Millisecond))
	}()

	ctx := r.Context()

	opts := graph.Options{
		Level:          graph.Level(r.URL.Query().Get("level")),
		Namespaces:     splitCSV(r.URL.Query().Get("namespaces")),
		IncludeDefault: r.URL.Query().Get("includeDefault") != "false",
	}

	updates, unsubscribe := s.opts.Source.Subscribe()
	defer unsubscribe()

	// Send the current graph immediately so a client never waits for the next
	// cluster change to draw something.
	if e, state := s.evaluator(); e != nil {
		if err := s.send(ctx, conn, streamMessage{
			Type:     "graph",
			Revision: state.Revision,
			Graph:    graph.Build(e, opts),
			Warnings: len(state.Warnings),
		}); err != nil {
			return
		}
	}

	// A reader is required for the connection to observe close frames and for
	// the library to answer pings.
	go func() {
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				return
			}
		}
	}()

	ping := time.NewTicker(streamPingInterval)
	defer ping.Stop()

	for {
		select {
		case <-ctx.Done():
			return

		case <-ping.C:
			pingCtx, cancel := context.WithTimeout(ctx, streamWriteTimeout)
			err := conn.Ping(pingCtx)
			cancel()
			if err != nil {
				return
			}

		case state, ok := <-updates:
			if !ok {
				return
			}
			if state.Snapshot == nil {
				continue
			}
			e := s.evaluatorFor(state)
			if err := s.send(ctx, conn, streamMessage{
				Type:     "graph",
				Revision: state.Revision,
				Graph:    graph.Build(e, opts),
				Warnings: len(state.Warnings),
			}); err != nil {
				return
			}
		}
	}
}

func (s *Server) send(ctx context.Context, conn *websocket.Conn, msg streamMessage) error {
	writeCtx, cancel := context.WithTimeout(ctx, streamWriteTimeout)
	defer cancel()

	if err := wsjson.Write(writeCtx, conn, msg); err != nil {
		if !errors.Is(err, context.Canceled) {
			s.log.Debug("websocket write failed; dropping client", "error", err)
		}
		return err
	}
	return nil
}
