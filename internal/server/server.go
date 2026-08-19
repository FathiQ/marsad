// Package server exposes the read-only HTTP and WebSocket API, and serves the
// embedded frontend.
//
// Every handler reads from an immutable cluster state. There are no write
// endpoints — not disabled ones, absent ones.
package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/FathiQ/marsad/pkg/cluster"
	"github.com/FathiQ/marsad/pkg/npeval"
)

// StateSource supplies cluster state. The server depends on this rather than on
// *cluster.Watcher directly so the handlers can be exercised against a fixed
// snapshot, with no informers and no cluster.
type StateSource interface {
	State() *cluster.State
	Subscribe() (<-chan *cluster.State, func())
}

// Options configures the server.
type Options struct {
	Source StateSource
	Log    *slog.Logger

	// CombineMode is how provider layers are combined; see npeval.CombineMode.
	CombineMode npeval.CombineMode

	// DevCORS allows any origin, for running the Vite dev server on a different
	// port. Off by default: the production binary serves the UI itself and has
	// no reason to accept cross-origin requests.
	DevCORS bool

	// Version is the build this binary came from, reported by /api/meta so that
	// "which version is running?" is answerable from the thing that is running
	// rather than inferred from a deployment spec.
	Version string
}

// Server holds the HTTP handlers.
type Server struct {
	opts Options
	log  *slog.Logger
	mux  *http.ServeMux
}

// New builds the server and registers its routes.
func New(opts Options) *Server {
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	s := &Server{opts: opts, log: opts.Log, mux: http.NewServeMux()}
	s.routes()
	return s
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /api/health", s.handleHealth)
	s.mux.HandleFunc("GET /api/meta", s.handleMeta)
	s.mux.HandleFunc("GET /api/namespaces", s.handleNamespaces)
	s.mux.HandleFunc("GET /api/graph", s.handleGraph)
	s.mux.HandleFunc("GET /api/workloads/{namespace}/{name}", s.handleWorkload)
	s.mux.HandleFunc("GET /api/rules", s.handleRules)
	s.mux.HandleFunc("POST /api/simulate", s.handleSimulate)
	s.mux.HandleFunc("GET /api/stream", s.handleStream)

	s.mux.Handle("/", frontendHandler())
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if s.opts.DevCORS {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "content-type")
	}
	// Belt and braces: the API has no write routes, and anything that is not a
	// read is refused before it reaches a handler.
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions, http.MethodPost:
	default:
		http.Error(w, "Marsad is read-only", http.StatusMethodNotAllowed)
		return
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	s.mux.ServeHTTP(w, r)
}

// evaluator returns an evaluator over the current state, or nil if the informer
// caches have not synced yet.
func (s *Server) evaluator() (*npeval.Evaluator, *cluster.State) {
	state := s.opts.Source.State()
	if state == nil || state.Snapshot == nil {
		return nil, nil
	}
	return npeval.New(state.Snapshot, npeval.WithCombineMode(s.opts.CombineMode)), state
}

// evaluatorFor builds an evaluator over a specific state, used by the stream so
// the graph it sends matches the revision it announces.
func (s *Server) evaluatorFor(state *cluster.State) *npeval.Evaluator {
	return npeval.New(state.Snapshot, npeval.WithCombineMode(s.opts.CombineMode))
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		s.log.Error("write response", "error", err)
	}
}

func (s *Server) writeError(w http.ResponseWriter, status int, msg string) {
	s.writeJSON(w, status, map[string]string{"error": msg})
}

// notReady is the state between process start and the first informer sync. It is
// a normal, brief condition, and the UI shows a loading skeleton for it rather
// than an error.
func (s *Server) notReady(w http.ResponseWriter) {
	s.writeJSON(w, http.StatusServiceUnavailable, map[string]any{
		"error": "cluster state is still syncing",
		"retry": true,
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	state := s.opts.Source.State()
	s.writeJSON(w, http.StatusOK, map[string]any{
		"ok":    state != nil,
		"ready": state != nil && state.Snapshot != nil,
		"time":  time.Now().UTC(),
	})
}
