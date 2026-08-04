package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/netip"
	"strings"

	"sigs.k8s.io/yaml"

	"github.com/FathiQ/marsad/pkg/graph"
	"github.com/FathiQ/marsad/pkg/npeval"
)

func (s *Server) handleMeta(w http.ResponseWriter, _ *http.Request) {
	state := s.opts.Source.State()
	if state == nil {
		s.notReady(w)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"revision":     state.Revision,
		"builtAt":      state.BuiltAt,
		"capabilities": state.Capabilities,
		"counts":       state.Counts,
		"warnings":     state.Warnings,
		"combineMode":  combineModeName(s.opts.CombineMode),
		"readOnly":     true,
	})
}

func combineModeName(m npeval.CombineMode) string {
	if m == npeval.CombineUnion {
		return "union"
	}
	return "intersect"
}

type namespaceSummary struct {
	Name        string `json:"name"`
	Workloads   int    `json:"workloads"`
	Policies    int    `json:"policies"`
	Unprotected int    `json:"unprotected"`
}

func (s *Server) handleNamespaces(w http.ResponseWriter, _ *http.Request) {
	e, state := s.evaluator()
	if e == nil {
		s.notReady(w)
		return
	}

	snap := state.Snapshot
	out := make([]namespaceSummary, 0, len(snap.Namespaces()))
	for _, ns := range snap.Namespaces() {
		summary := namespaceSummary{
			Name:      ns.Name,
			Policies:  len(snap.Policies(ns.Name)),
			Workloads: len(snap.Workloads(ns.Name)),
		}
		for _, wl := range snap.Workloads(ns.Name) {
			iso := e.Isolation(wl.Ref)
			if !iso.Ingress && !iso.Egress {
				summary.Unprotected++
			}
		}
		out = append(out, summary)
	}
	s.writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleGraph(w http.ResponseWriter, r *http.Request) {
	e, state := s.evaluator()
	if e == nil {
		s.notReady(w)
		return
	}

	opts := graph.Options{
		Level:          graph.Level(r.URL.Query().Get("level")),
		Namespaces:     splitCSV(r.URL.Query().Get("namespaces")),
		IncludeDefault: r.URL.Query().Get("includeDefault") != "false",
	}
	switch opts.Level {
	case "", graph.LevelNamespace, graph.LevelWorkload:
	default:
		s.writeError(w, http.StatusBadRequest,
			fmt.Sprintf("unknown level %q; use namespace or workload", opts.Level))
		return
	}

	g := graph.Build(e, opts)
	s.writeJSON(w, http.StatusOK, map[string]any{
		"revision": state.Revision,
		"graph":    g,
	})
}

// policyView carries a policy plus its original YAML, which is what the detail
// drawer's read-only viewer renders.
type policyView struct {
	Ref      npeval.ObjectRef `json:"ref"`
	Provider string           `json:"provider"`
	Types    string           `json:"types"`
	Selector string           `json:"selector"`
	YAML     string           `json:"yaml,omitempty"`
}

type workloadDetail struct {
	Workload  npeval.Workload  `json:"workload"`
	Isolation npeval.Isolation `json:"isolation"`
	Policies  []policyView     `json:"policies"`
	Ingress   npeval.Effective `json:"ingress"`
	Egress    npeval.Effective `json:"egress"`
}

func (s *Server) handleWorkload(w http.ResponseWriter, r *http.Request) {
	e, _ := s.evaluator()
	if e == nil {
		s.notReady(w)
		return
	}

	namespace := r.PathValue("namespace")
	name := r.PathValue("name")

	// The graph node id carries the kind, but a bare namespace/name is the
	// friendlier URL, so accept it and disambiguate by searching the namespace.
	var found *npeval.Workload
	for _, wl := range e.Snapshot().Workloads(namespace) {
		if wl.Ref.Name == name {
			if kind := r.URL.Query().Get("kind"); kind != "" && wl.Ref.Kind != kind {
				continue
			}
			w := wl
			found = &w
			break
		}
	}
	if found == nil {
		s.writeError(w, http.StatusNotFound, fmt.Sprintf("no workload %s/%s", namespace, name))
		return
	}

	detail := workloadDetail{
		Workload:  *found,
		Isolation: e.Isolation(found.Ref),
		Ingress:   e.Effective(found.Ref, npeval.DirIngress),
		Egress:    e.Effective(found.Ref, npeval.DirEgress),
	}
	for _, m := range e.PoliciesFor(found.Ref) {
		p, ok := e.Snapshot().Policy(m.Policy)
		if !ok {
			continue
		}
		detail.Policies = append(detail.Policies, policyView{
			Ref:      p.Ref,
			Provider: p.Provider,
			Types:    p.Types.String(),
			Selector: p.Selector.String(),
			YAML:     rawYAML(p.Raw),
		})
	}

	s.writeJSON(w, http.StatusOK, detail)
}

// rawYAML renders the original object for the viewer. A failure here is cosmetic
// — the rest of the drawer is still useful — so it degrades to a note.
func rawYAML(raw any) string {
	if raw == nil {
		return ""
	}
	b, err := yaml.Marshal(raw)
	if err != nil {
		return fmt.Sprintf("# could not render the original object: %v", err)
	}
	return string(b)
}

type simulateRequest struct {
	From     endpointRequest `json:"from"`
	To       endpointRequest `json:"to"`
	Protocol string          `json:"protocol"`
	Port     int32           `json:"port"`
}

type endpointRequest struct {
	Namespace string `json:"namespace,omitempty"`
	Name      string `json:"name,omitempty"`
	Kind      string `json:"kind,omitempty"`
	CIDR      string `json:"cidr,omitempty"`
	Domain    string `json:"domain,omitempty"`
}

// resolve turns the request form into an npeval endpoint. A bare IP is accepted
// as well as a prefix, since that is what a user actually has to hand.
func (er endpointRequest) resolve(e *npeval.Evaluator) (npeval.Endpoint, error) {
	switch {
	case er.Domain != "":
		return npeval.Endpoint{Domain: er.Domain}, nil

	case er.CIDR != "":
		text := er.CIDR
		if !strings.Contains(text, "/") {
			addr, err := netip.ParseAddr(text)
			if err != nil {
				return npeval.Endpoint{}, fmt.Errorf("%q is not an IP address or CIDR", er.CIDR)
			}
			text = fmt.Sprintf("%s/%d", addr, addr.BitLen())
		}
		p, err := netip.ParsePrefix(text)
		if err != nil {
			return npeval.Endpoint{}, fmt.Errorf("%q is not a valid CIDR", er.CIDR)
		}
		return npeval.Endpoint{CIDR: &p}, nil

	case er.Name != "" && er.Namespace != "":
		for _, wl := range e.Snapshot().Workloads(er.Namespace) {
			if wl.Ref.Name != er.Name {
				continue
			}
			if er.Kind != "" && wl.Ref.Kind != er.Kind {
				continue
			}
			ref := wl.Ref
			return npeval.Endpoint{Workload: &ref}, nil
		}
		return npeval.Endpoint{}, fmt.Errorf("no workload %s/%s", er.Namespace, er.Name)

	default:
		return npeval.Endpoint{}, fmt.Errorf("give a workload (namespace and name), a cidr, or a domain")
	}
}

// handleSimulate answers "would this connection be allowed", with the policy
// path that decides it. POST rather than GET only because the query is a
// structured object; it reads nothing but the in-memory snapshot and changes
// nothing.
func (s *Server) handleSimulate(w http.ResponseWriter, r *http.Request) {
	e, _ := s.evaluator()
	if e == nil {
		s.notReady(w)
		return
	}

	var req simulateRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		s.writeError(w, http.StatusBadRequest, fmt.Sprintf("invalid request body: %v", err))
		return
	}

	from, err := req.From.resolve(e)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "from: "+err.Error())
		return
	}
	to, err := req.To.resolve(e)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "to: "+err.Error())
		return
	}

	protocol := npeval.Protocol(strings.ToUpper(req.Protocol))
	if protocol == "" {
		protocol = npeval.ProtocolTCP
	}

	verdict, err := e.Simulate(npeval.Query{From: from, To: to, Protocol: protocol, Port: req.Port})
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.writeJSON(w, http.StatusOK, verdict)
}

func splitCSV(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
