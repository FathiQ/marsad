package npeval

import (
	"errors"
	"fmt"
	"net/netip"
	"slices"
	"strings"
)

// Endpoint is one side of a simulated connection. Exactly one field must be set.
type Endpoint struct {
	Workload *ObjectRef    `json:"workload,omitempty"`
	CIDR     *netip.Prefix `json:"cidr,omitempty"`
	Domain   string        `json:"domain,omitempty"`
}

func (ep Endpoint) validate(side string) error {
	n := 0
	if ep.Workload != nil {
		n++
	}
	if ep.CIDR != nil {
		n++
	}
	if ep.Domain != "" {
		n++
	}
	switch n {
	case 1:
		return nil
	case 0:
		return fmt.Errorf("%s endpoint: one of workload, cidr or domain must be set", side)
	default:
		return fmt.Errorf("%s endpoint: only one of workload, cidr or domain may be set", side)
	}
}

func (ep Endpoint) String() string {
	switch {
	case ep.Workload != nil:
		return ep.Workload.String()
	case ep.CIDR != nil:
		return ep.CIDR.String()
	default:
		return ep.Domain
	}
}

// Query is a hypothetical connection to evaluate.
type Query struct {
	From     Endpoint `json:"from"`
	To       Endpoint `json:"to"`
	Protocol Protocol `json:"protocol"`
	Port     int32    `json:"port"`
}

// Result is the outcome of one half of a simulation.
type Result int

// The outcomes of one half of a simulation.
const (
	// ResultNotApplicable means this half has no policy to apply, because the
	// endpoint is not a workload in the snapshot.
	ResultNotApplicable Result = iota
	ResultAllowed
	ResultDenied
	// ResultUndecidable means configuration alone cannot answer, because
	// deciding would require knowing what a domain name resolves to.
	ResultUndecidable
)

func (r Result) String() string {
	switch r {
	case ResultAllowed:
		return "ALLOWED"
	case ResultDenied:
		return "DENIED"
	case ResultUndecidable:
		return "UNDECIDABLE"
	default:
		return "N/A"
	}
}

// Reason explains a Result.
type Reason int

// The explanations a Decision can carry.
const (
	// ReasonNone is the zero value, used when a Result needs no explanation.
	ReasonNone Reason = iota
	// ReasonNotIsolated means no policy governs this direction, so the default
	// allow-everything applies.
	ReasonNotIsolated
	ReasonMatchedRule
	ReasonNoMatchingRule
	// ReasonNoPolicySelects means the workload is isolated by some policy but no
	// rule covers this peer. Kept distinct from ReasonNoMatchingRule so the UI
	// can say "nothing selects this" rather than "no rule matched".
	ReasonNoPolicySelects
	ReasonUnknownWorkload
	ReasonDomainResolution
)

func (r Reason) String() string {
	switch r {
	case ReasonNotIsolated:
		return "not isolated"
	case ReasonMatchedRule:
		return "matched rule"
	case ReasonNoMatchingRule:
		return "no matching rule"
	case ReasonNoPolicySelects:
		return "no policy selects workload"
	case ReasonUnknownWorkload:
		return "workload not in snapshot"
	case ReasonDomainResolution:
		return "depends on domain resolution"
	default:
		return ""
	}
}

// Decision is one half of a verdict.
type Decision struct {
	Result  Result            `json:"result"`
	Reason  Reason            `json:"reason"`
	Via     []RuleID          `json:"via,omitempty"`
	Explain string            `json:"explain"`
	ByLayer map[string]Result `json:"byLayer,omitempty"`
}

// Verdict is the full answer: a connection needs the source's egress and the
// destination's ingress to both permit it. Hand-reading policy usually goes
// wrong by checking only one side, so both are always reported.
type Verdict struct {
	Allowed     bool     `json:"allowed"`
	Undecidable bool     `json:"undecidable"`
	Egress      Decision `json:"egress"`
	Ingress     Decision `json:"ingress"`
	Summary     string   `json:"summary"`
}

// Simulate evaluates whether a connection would be permitted by declared policy.
func (e *Evaluator) Simulate(q Query) (Verdict, error) {
	if err := errors.Join(q.From.validate("from"), q.To.validate("to")); err != nil {
		return Verdict{}, err
	}
	if q.Protocol == "" {
		q.Protocol = ProtocolTCP
	}
	if q.Port < 1 || q.Port > 65535 {
		return Verdict{}, fmt.Errorf("port %d out of range 1-65535", q.Port)
	}

	v := Verdict{
		Egress:  e.decide(q.From, q.To, DirEgress, q),
		Ingress: e.decide(q.To, q.From, DirIngress, q),
	}

	v.Undecidable = v.Egress.Result == ResultUndecidable || v.Ingress.Result == ResultUndecidable
	v.Allowed = !v.Undecidable &&
		v.Egress.Result != ResultDenied &&
		v.Ingress.Result != ResultDenied

	switch {
	case v.Undecidable:
		v.Summary = fmt.Sprintf("UNDECIDABLE: %s → %s on %d/%s", q.From, q.To, q.Port, q.Protocol)
	case v.Allowed:
		v.Summary = fmt.Sprintf("ALLOWED: %s → %s on %d/%s", q.From, q.To, q.Port, q.Protocol)
	default:
		v.Summary = fmt.Sprintf("DENIED: %s → %s on %d/%s", q.From, q.To, q.Port, q.Protocol)
	}
	return v, nil
}

// decide evaluates one direction on one endpoint against the other endpoint.
func (e *Evaluator) decide(subject, other Endpoint, dir Direction, q Query) Decision {
	if subject.Workload == nil {
		return Decision{
			Result:  ResultNotApplicable,
			Explain: fmt.Sprintf("%s is not a workload, so no %s policy applies to it", subject, dir),
		}
	}
	ref := *subject.Workload
	if _, ok := e.snap.Workload(ref); !ok {
		return Decision{
			Result:  ResultNotApplicable,
			Reason:  ReasonUnknownWorkload,
			Explain: fmt.Sprintf("%s is not present in the snapshot", ref),
		}
	}

	eff := e.Effective(ref, dir)
	if !eff.Isolated {
		return Decision{
			Result:  ResultAllowed,
			Reason:  ReasonNotIsolated,
			Explain: fmt.Sprintf("no policy applies %s rules to %s, so all %s traffic is allowed by default", dir, ref, dir),
		}
	}

	byLayer := make(map[string]Result, len(eff.Layers))
	for _, l := range eff.Layers {
		byLayer[l.Provider] = ResultDenied
		for _, a := range l.Allows {
			if peerMatches(a.Peer, other) && portsAllow(a.Ports, q.Protocol, q.Port) {
				byLayer[l.Provider] = ResultAllowed
				break
			}
		}
	}

	var via []RuleID
	for _, a := range eff.Allows {
		if peerMatches(a.Peer, other) && portsAllow(a.Ports, q.Protocol, q.Port) {
			via = append(via, a.Via...)
		}
	}
	if len(via) > 0 {
		slices.Sort(via)
		via = slices.Compact(via)
		return Decision{
			Result:  ResultAllowed,
			Reason:  ReasonMatchedRule,
			Via:     via,
			ByLayer: byLayer,
			Explain: fmt.Sprintf("%s %s to %s on %d/%s allowed by %s",
				ref, dir, other, q.Port, q.Protocol, joinRuleIDs(via)),
		}
	}

	// Before reporting a denial, check whether the only thing standing between
	// this query and a match is a domain name we cannot resolve. Saying DENIED
	// when the honest answer is "depends on DNS" would be worse than useless in
	// a security tool.
	if note, undecidable := e.undecidableAgainst(eff, other, q); undecidable {
		return Decision{
			Result:  ResultUndecidable,
			Reason:  ReasonDomainResolution,
			ByLayer: byLayer,
			Explain: note,
		}
	}

	isolatedBy := make([]string, 0, len(eff.Layers))
	for _, l := range eff.Layers {
		for _, ref := range l.By {
			isolatedBy = append(isolatedBy, ref.String())
		}
	}
	return Decision{
		Result:  ResultDenied,
		Reason:  ReasonNoMatchingRule,
		ByLayer: byLayer,
		Explain: fmt.Sprintf("%s is %s-isolated by %s and no rule allows %s on %d/%s",
			ref, dir, strings.Join(isolatedBy, ", "), other, q.Port, q.Protocol),
	}
}

// undecidableAgainst reports whether a domain-versus-address mismatch is the
// only reason nothing matched.
func (e *Evaluator) undecidableAgainst(eff Effective, other Endpoint, q Query) (string, bool) {
	for _, a := range eff.Allows {
		if !portsAllow(a.Ports, q.Protocol, q.Port) {
			continue
		}
		switch {
		case a.Peer.Kind == PeerDomain && other.CIDR != nil:
			return fmt.Sprintf(
				"policy allows the domain %s on %d/%s; whether %s is one of its addresses depends on DNS resolution, which Marsad does not observe",
				a.Peer.Domain, q.Port, q.Protocol, other.CIDR), true
		case a.Peer.Kind == PeerCIDR && other.Domain != "":
			return fmt.Sprintf(
				"policy allows %s on %d/%s; whether %s resolves into that range depends on DNS resolution, which Marsad does not observe",
				a.Peer.CIDR, q.Port, q.Protocol, other.Domain), true
		}
	}
	return "", false
}

// peerMatches reports whether a resolved peer covers an endpoint.
func peerMatches(p ResolvedPeer, ep Endpoint) bool {
	switch p.Kind {
	case PeerAny:
		return true
	case PeerPods:
		return ep.Workload != nil && slices.Contains(p.Workloads, *ep.Workload)
	case PeerCIDR:
		if ep.CIDR == nil {
			return false
		}
		// The whole queried range must be inside the allowed block, and no
		// exclusion may touch it.
		if p.CIDR.Bits() > ep.CIDR.Bits() || !p.CIDR.Overlaps(*ep.CIDR) {
			return false
		}
		for _, x := range p.Except {
			if x.Overlaps(*ep.CIDR) {
				return false
			}
		}
		return true
	case PeerDomain:
		return ep.Domain != "" && MatchDomain(p.Domain, ep.Domain)
	default:
		return false
	}
}

func joinRuleIDs(ids []RuleID) string {
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = string(id)
	}
	return strings.Join(parts, ", ")
}
