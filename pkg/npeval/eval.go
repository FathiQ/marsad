package npeval

import (
	"fmt"
	"net/netip"
	"slices"
	"strings"
)

// CombineMode decides how independent provider layers are combined.
type CombineMode int

const (
	// CombineIntersect requires every isolating layer to permit the traffic.
	// This is the default and the conservative reading of the AWS
	// ApplicationNetworkPolicy CRD, whose field documentation says outgoing
	// traffic is allowed when no ANP selects the pod "and cluster policy
	// otherwise allows the traffic".
	CombineIntersect CombineMode = iota
	// CombineUnion lets any isolating layer permit traffic on its own. Offered
	// because the CRD sentence is ambiguous and a security tool should not
	// silently bet on one reading.
	CombineUnion
)

// Option configures an Evaluator.
type Option func(*Evaluator)

// WithCombineMode selects how provider layers are combined.
func WithCombineMode(m CombineMode) Option {
	return func(e *Evaluator) { e.combine = m }
}

// Evaluator answers policy questions about a Snapshot. It holds no mutable
// state and is safe for concurrent use.
type Evaluator struct {
	snap    *Snapshot
	combine CombineMode
}

// New returns an Evaluator over a snapshot.
func New(s *Snapshot, opts ...Option) *Evaluator {
	e := &Evaluator{snap: s}
	for _, o := range opts {
		o(e)
	}
	return e
}

// Snapshot returns the snapshot being evaluated.
func (e *Evaluator) Snapshot() *Snapshot { return e.snap }

// PolicyMatch records that a policy selects a workload, and what it governs.
type PolicyMatch struct {
	Policy   ObjectRef   `json:"policy"`
	Provider string      `json:"provider"`
	Types    PolicyTypes `json:"types"`
}

// PoliciesFor returns the policies selecting a workload, sorted.
func (e *Evaluator) PoliciesFor(w ObjectRef) []PolicyMatch {
	refs := e.snap.selectedBy[w]
	out := make([]PolicyMatch, 0, len(refs))
	for _, r := range refs {
		p, ok := e.snap.polByRef[r]
		if !ok {
			continue
		}
		out = append(out, PolicyMatch{Policy: p.Ref, Provider: p.Provider, Types: p.Types})
	}
	return out
}

// SelectedBy returns the workloads a policy selects, sorted. An empty result
// means the policy is dead — it matches nothing, usually label drift.
func (e *Evaluator) SelectedBy(p ObjectRef) []ObjectRef {
	return slices.Clone(e.snap.selects[p])
}

// Isolation reports whether a workload is isolated in each direction, and which
// policies caused it.
//
// A workload selected by any policy whose policyTypes contains Ingress is
// ingress-isolated, even when that policy has no ingress rules at all — that is
// exactly how default-deny is written. A workload no policy selects is wide open
// in both directions.
type Isolation struct {
	Ingress   bool        `json:"ingress"`
	Egress    bool        `json:"egress"`
	IngressBy []ObjectRef `json:"ingressBy,omitempty"`
	EgressBy  []ObjectRef `json:"egressBy,omitempty"`
}

// Isolation reports isolation across all providers.
func (e *Evaluator) Isolation(w ObjectRef) Isolation {
	var iso Isolation
	for _, m := range e.PoliciesFor(w) {
		if m.Types.Has(TypeIngress) {
			iso.Ingress = true
			iso.IngressBy = append(iso.IngressBy, m.Policy)
		}
		if m.Types.Has(TypeEgress) {
			iso.Egress = true
			iso.EgressBy = append(iso.EgressBy, m.Policy)
		}
	}
	return iso
}

// IsolationByProvider reports isolation separately for each provider that has a
// policy selecting the workload.
func (e *Evaluator) IsolationByProvider(w ObjectRef) map[string]Isolation {
	out := map[string]Isolation{}
	for _, m := range e.PoliciesFor(w) {
		iso := out[m.Provider]
		if m.Types.Has(TypeIngress) {
			iso.Ingress = true
			iso.IngressBy = append(iso.IngressBy, m.Policy)
		}
		if m.Types.Has(TypeEgress) {
			iso.Egress = true
			iso.EgressBy = append(iso.EgressBy, m.Policy)
		}
		out[m.Provider] = iso
	}
	return out
}

// ResolvedPeer is a peer with selectors resolved against the current snapshot.
type ResolvedPeer struct {
	Kind PeerKind `json:"kind"`

	Namespaces []string    `json:"namespaces,omitempty"`
	Workloads  []ObjectRef `json:"workloads,omitempty"`

	CIDR   netip.Prefix   `json:"cidr,omitzero"`
	Except []netip.Prefix `json:"except,omitempty"`
	Domain string         `json:"domain,omitempty"`

	// Display is the human-readable edge label.
	Display string `json:"display"`
}

// key identifies a peer for merging and deduplication.
func (p ResolvedPeer) key() string {
	switch p.Kind {
	case PeerAny:
		return displayAny
	case PeerCIDR:
		var b strings.Builder
		b.WriteString("cidr:")
		b.WriteString(p.CIDR.String())
		for _, x := range p.Except {
			b.WriteString("!")
			b.WriteString(x.String())
		}
		return b.String()
	case PeerDomain:
		return "domain:" + p.Domain
	case PeerPods:
		var b strings.Builder
		b.WriteString("pods:")
		for _, w := range p.Workloads {
			b.WriteString(w.String())
			b.WriteByte(',')
		}
		// Namespaces matter even with no workloads: an empty namespace is a real
		// peer that simply has nothing in it yet.
		b.WriteString("|ns:")
		b.WriteString(strings.Join(p.Namespaces, ","))
		return b.String()
	default:
		return "invalid"
	}
}

// Allow is one entry of an effective allow-set: a peer, the ports permitted to
// or from it, and the rules that said so.
type Allow struct {
	Peer  ResolvedPeer `json:"peer"`
	Ports []PortRange  `json:"ports,omitempty"` // empty means all ports
	Via   []RuleID     `json:"via"`

	// Approximate is set when combining provider layers could not be decided
	// from configuration alone — a domain peer intersected with a CIDR peer, for
	// instance, since domain-to-address resolution is a runtime fact. Note says
	// why. The UI must render these differently from exact edges.
	Approximate bool   `json:"approximate,omitempty"`
	Note        string `json:"note,omitempty"`
}

// Layer is one provider's contribution to a workload's effective policy.
// Only isolating layers appear: a provider that selects the workload but does
// not govern this direction restricts nothing and has nothing to contribute.
type Layer struct {
	Provider string      `json:"provider"`
	Isolated bool        `json:"isolated"`
	By       []ObjectRef `json:"by,omitempty"`
	Allows   []Allow     `json:"allows,omitempty"`
}

// Effective is the evaluated allow-set for one workload in one direction.
type Effective struct {
	Workload  ObjectRef `json:"workload"`
	Direction Direction `json:"direction"`

	// Isolated is false when no layer governs this direction, meaning everything
	// is permitted by default and Allows is empty. The UI draws that case as
	// dashed "allowed by default" rather than as an explicit edge, so the
	// distinction is kept in the data instead of being flattened into a
	// synthetic allow-everything entry.
	Isolated bool `json:"isolated"`

	Layers []Layer `json:"layers,omitempty"`
	Allows []Allow `json:"allows,omitempty"`
}

// Effective computes the allow-set for a workload in one direction.
func (e *Evaluator) Effective(ref ObjectRef, dir Direction) Effective {
	res := Effective{Workload: ref, Direction: dir}

	subject, ok := e.snap.Workload(ref)
	if !ok {
		return res
	}

	byProvider := map[string]*Layer{}
	var order []string
	for _, m := range e.PoliciesFor(ref) {
		if !m.Types.Has(dir.For()) {
			continue
		}
		p, ok := e.snap.Policy(m.Policy)
		if !ok {
			continue
		}
		layer, seen := byProvider[p.Provider]
		if !seen {
			layer = &Layer{Provider: p.Provider, Isolated: true}
			byProvider[p.Provider] = layer
			order = append(order, p.Provider)
		}
		layer.By = append(layer.By, p.Ref)
		for _, rule := range p.Rules(dir) {
			layer.Allows = append(layer.Allows, e.ruleAllows(p, rule, dir, subject)...)
		}
	}

	if len(order) == 0 {
		return res
	}

	slices.Sort(order)
	res.Isolated = true
	for _, name := range order {
		l := byProvider[name]
		l.Allows = mergeAllows(l.Allows)
		res.Layers = append(res.Layers, *l)
	}

	res.Allows = combineLayers(res.Layers, e.combine)
	return res
}

// EffectiveAll computes both directions for every workload in the given
// namespaces, or for the whole snapshot when none are given.
func (e *Evaluator) EffectiveAll(namespaces ...string) []Effective {
	var workloads []Workload
	if len(namespaces) == 0 {
		workloads = e.snap.Workloads("")
	} else {
		for _, ns := range namespaces {
			workloads = append(workloads, e.snap.Workloads(ns)...)
		}
		slices.SortFunc(workloads, func(a, b Workload) int { return a.Ref.Compare(b.Ref) })
	}

	out := make([]Effective, 0, len(workloads)*2)
	for _, w := range workloads {
		out = append(out, e.Effective(w.Ref, DirIngress), e.Effective(w.Ref, DirEgress))
	}
	return out
}

// ruleAllows expands one rule into allow entries.
func (e *Evaluator) ruleAllows(p Policy, rule Rule, dir Direction, subject Workload) []Allow {
	if rule.AllPeers {
		peer := ResolvedPeer{Kind: PeerAny, Display: displayAny}
		return []Allow{{
			Peer:  peer,
			Ports: e.rulePorts(rule, dir, subject, peer),
			Via:   []RuleID{rule.ID},
		}}
	}

	out := make([]Allow, 0, len(rule.Peers))
	for _, peer := range rule.Peers {
		resolved := e.resolvePeer(p, peer)
		out = append(out, Allow{
			Peer:  resolved,
			Ports: e.rulePorts(rule, dir, subject, resolved),
			Via:   []RuleID{rule.ID},
		})
	}
	return out
}

// rulePorts returns the rule's ports with named entries resolved.
//
// Named ports resolve against the pods the policy selects for ingress, and
// against the destination pods for egress — so the same rule can yield different
// numbers for different peers.
func (e *Evaluator) rulePorts(rule Rule, dir Direction, subject Workload, peer ResolvedPeer) []PortRange {
	if rule.AllPorts {
		return nil
	}
	targets := []Workload{subject}
	if dir == DirEgress {
		targets = targets[:0]
		for _, ref := range peer.Workloads {
			if w, ok := e.snap.Workload(ref); ok {
				targets = append(targets, w)
			}
		}
	}
	return dedupePorts(resolveNamedPorts(rule.Ports, targets))
}

// resolvePeer turns selectors into the concrete namespaces and workloads they
// match right now.
func (e *Evaluator) resolvePeer(p Policy, peer Peer) ResolvedPeer {
	switch peer.Kind {
	case PeerCIDR:
		return ResolvedPeer{
			Kind:    PeerCIDR,
			CIDR:    peer.CIDR,
			Except:  slices.Clone(peer.Except),
			Display: cidrDisplay(peer.CIDR, peer.Except),
		}
	case PeerDomain:
		d := NormalizeDomain(peer.Domain)
		return ResolvedPeer{Kind: PeerDomain, Domain: d, Display: d}
	case PeerPods:
		namespaces := e.snap.matchingNamespaces(peer.NamespaceSelector, p.Ref.Namespace)
		podSel := EverythingSelector()
		if peer.PodSelector != nil {
			podSel = *peer.PodSelector
		}
		var workloads []ObjectRef
		for _, ns := range namespaces {
			for _, w := range e.snap.wlByNS[ns] {
				if podSel.Matches(w.Labels) {
					workloads = append(workloads, w.Ref)
				}
			}
		}
		slices.SortFunc(workloads, ObjectRef.Compare)
		return ResolvedPeer{
			Kind:       PeerPods,
			Namespaces: namespaces,
			Workloads:  workloads,
			Display:    podsDisplay(peer, p.Ref.Namespace, namespaces),
		}
	default:
		return ResolvedPeer{Kind: PeerAny, Display: displayAny}
	}
}

func cidrDisplay(cidr netip.Prefix, except []netip.Prefix) string {
	s := cidr.String()
	if cidr.Bits() == 0 {
		s += " (world)"
	}
	if len(except) == 0 {
		return s
	}
	parts := make([]string, 0, len(except))
	for _, x := range except {
		parts = append(parts, x.String())
	}
	return fmt.Sprintf("%s except %s", s, strings.Join(parts, ","))
}

func podsDisplay(peer Peer, policyNamespace string, matched []string) string {
	var ns string
	switch {
	case peer.NamespaceSelector == nil:
		ns = "ns=" + policyNamespace
	case peer.NamespaceSelector.MatchesEverything():
		ns = "all namespaces"
	default:
		ns = "ns:" + peer.NamespaceSelector.String()
		if len(matched) > 0 && len(matched) <= 3 {
			ns += " (" + strings.Join(matched, ",") + ")"
		}
	}
	if peer.PodSelector == nil || peer.PodSelector.MatchesEverything() {
		return ns + ", all pods"
	}
	return ns + ", " + peer.PodSelector.String()
}

// mergeAllows folds entries that name the same peer into one, unioning their
// ports and rule references. Within a provider, policies are additive.
func mergeAllows(allows []Allow) []Allow {
	if len(allows) <= 1 {
		return allows
	}
	byKey := map[string]*Allow{}
	var order []string
	for _, a := range allows {
		k := a.Peer.key()
		cur, seen := byKey[k]
		if !seen {
			cp := a
			cp.Ports = slices.Clone(a.Ports)
			cp.Via = slices.Clone(a.Via)
			byKey[k] = &cp
			order = append(order, k)
			continue
		}
		// An unrestricted entry subsumes every port restriction on the same peer.
		if len(cur.Ports) == 0 || len(a.Ports) == 0 {
			cur.Ports = nil
		} else {
			cur.Ports = dedupePorts(append(cur.Ports, a.Ports...))
		}
		cur.Via = append(cur.Via, a.Via...)
	}

	slices.Sort(order)
	out := make([]Allow, 0, len(order))
	for _, k := range order {
		a := byKey[k]
		slices.Sort(a.Via)
		a.Via = slices.Compact(a.Via)
		out = append(out, *a)
	}
	return out
}
