package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"sigs.k8s.io/yaml"

	"github.com/FathiQ/marsad/pkg/npeval"
)

// ruleDetail is what the edge popover renders: the one rule behind an edge,
// rather than the document it lives in.
//
// A NetworkPolicy is frequently a hundred lines governing several directions,
// and an edge is produced by exactly one entry of one list. Showing the whole
// object and leaving someone to find the relevant six lines is the difference
// between traceability and a haystack.
type ruleDetail struct {
	ID       npeval.RuleID    `json:"id"`
	Policy   npeval.ObjectRef `json:"policy"`
	Provider string           `json:"provider"`
	Path     string           `json:"path"`
	// YAML is the excerpt at Path, not the whole object.
	YAML string `json:"yaml,omitempty"`
	// Cautions are things true of this rule that are easy to read past.
	// Derived from the rule, never from a list of known-bad names.
	Cautions []string `json:"cautions,omitempty"`
}

// handleRules resolves rule identifiers to their policy, their YAML excerpt and
// anything about them worth saying out loud.
func (s *Server) handleRules(w http.ResponseWriter, r *http.Request) {
	e, _ := s.evaluator()
	if e == nil {
		s.notReady(w)
		return
	}

	ids := splitCSV(r.URL.Query().Get("ids"))
	if len(ids) == 0 {
		s.writeError(w, http.StatusBadRequest, "give one or more rule ids in ?ids=")
		return
	}
	// A bound, because the parameter is attacker-controlled in the sense that
	// anything reaching this endpoint can ask for arbitrarily many.
	const maxIDs = 64
	if len(ids) > maxIDs {
		s.writeError(w, http.StatusBadRequest,
			fmt.Sprintf("asked for %d rules; the limit is %d", len(ids), maxIDs))
		return
	}

	// Indexed rather than parsed out of the identifier. The format encodes the
	// policy — "networking.k8s.io/NetworkPolicy/prod/api-allow#ingress[0]" — but
	// taking it apart makes the wire format a parsing contract, and a policy
	// name containing '#' or '/' would quietly resolve to the wrong object.
	index := map[npeval.RuleID]ruleDetail{}
	for _, p := range e.Snapshot().Policies("") {
		for _, dir := range []npeval.Direction{npeval.DirIngress, npeval.DirEgress} {
			for _, rule := range p.Rules(dir) {
				index[rule.ID] = ruleDetail{
					ID:       rule.ID,
					Policy:   p.Ref,
					Provider: p.Provider,
					Path:     rule.Path,
					YAML:     excerpt(p.Raw, rule.Path),
					Cautions: cautions(rule),
				}
			}
		}
	}

	out := make([]ruleDetail, 0, len(ids))
	for _, id := range ids {
		if d, ok := index[npeval.RuleID(id)]; ok {
			out = append(out, d)
		}
	}
	s.writeJSON(w, http.StatusOK, out)
}

// cautions states what a rule permits when the wording makes it easy to miss.
//
// Derived from the rule's own peers, so a policy that reaches everything says
// so however it was written. Hardcoding "0.0.0.0/0" as a string to match would
// miss ::/0, and would say nothing about a rule with no `from` list at all —
// which is the broadest form there is.
func cautions(rule npeval.Rule) []string {
	var out []string

	if rule.AllPeers {
		out = append(out, "This rule names no peer at all, which matches every source and destination — in the cluster and outside it.")
	}
	for _, peer := range rule.Peers {
		if peer.Kind != npeval.PeerCIDR || !peer.CIDR.IsValid() || peer.CIDR.Bits() != 0 {
			continue
		}
		line := fmt.Sprintf("%s accepts from every address, in the cluster and outside it.", peer.CIDR)
		if len(peer.Except) > 0 {
			excluded := make([]string, len(peer.Except))
			for i, x := range peer.Except {
				excluded[i] = x.String()
			}
			line = fmt.Sprintf("%s covers every address except %s — in the cluster and outside it.",
				peer.CIDR, strings.Join(excluded, ", "))
		}
		out = append(out, line)
	}
	if rule.AllPorts {
		out = append(out, "It names no port, so it covers every port of every protocol.")
	}
	return out
}

var pathSegment = regexp.MustCompile(`^([A-Za-z0-9_]+)(?:\[(\d+)\])?$`)

// excerpt renders the sub-document at a field path such as "spec.ingress[0]".
//
// The original object is walked as generic JSON rather than reflected over,
// because Raw holds whichever typed object a provider handed in and the paths
// are produced by those same providers. A path that does not resolve yields
// nothing rather than an error: an excerpt is an aid, and the popover has the
// policy name and the rest of its content regardless.
func excerpt(raw any, path string) string {
	if raw == nil || path == "" {
		return ""
	}

	b, err := json.Marshal(raw)
	if err != nil {
		return ""
	}
	var node any
	if err := json.Unmarshal(b, &node); err != nil {
		return ""
	}

	for _, segment := range strings.Split(path, ".") {
		m := pathSegment.FindStringSubmatch(segment)
		if m == nil {
			return ""
		}
		obj, ok := node.(map[string]any)
		if !ok {
			return ""
		}
		node, ok = obj[m[1]]
		if !ok {
			return ""
		}
		if m[2] == "" {
			continue
		}
		i, err := strconv.Atoi(m[2])
		if err != nil {
			return ""
		}
		list, ok := node.([]any)
		if !ok || i < 0 || i >= len(list) {
			return ""
		}
		node = list[i]
	}

	out, err := yaml.Marshal(node)
	if err != nil {
		return ""
	}
	return string(out)
}
