package npeval

import (
	"encoding/json"
	"fmt"
	"net/netip"
	"strings"
)

// PolicyTypes is a bitmask of the directions a policy governs.
type PolicyTypes uint8

// The bits of a PolicyTypes mask.
const (
	TypeIngress PolicyTypes = 1 << iota
	TypeEgress
)

// Has reports whether every bit in o is set in t.
func (t PolicyTypes) Has(o PolicyTypes) bool { return t&o == o }

// For returns the bit corresponding to a direction.
func (d Direction) For() PolicyTypes {
	if d == DirEgress {
		return TypeEgress
	}
	return TypeIngress
}

func (t PolicyTypes) String() string {
	switch {
	case t.Has(TypeIngress | TypeEgress):
		return "Ingress,Egress"
	case t.Has(TypeEgress):
		return "Egress"
	case t.Has(TypeIngress):
		return "Ingress"
	default:
		return ""
	}
}

// MarshalJSON encodes the directions by name rather than as a bitmask, for the
// same reason Result and Reason do: a client should not have to know that
// egress happens to be the second bit set.
func (t PolicyTypes) MarshalJSON() ([]byte, error) { return json.Marshal(t.String()) }

// UnmarshalJSON accepts the name form, so a policy survives a round trip.
func (t *PolicyTypes) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	var out PolicyTypes
	for _, part := range strings.Split(s, ",") {
		switch strings.TrimSpace(part) {
		case "Ingress":
			out |= TypeIngress
		case "Egress":
			out |= TypeEgress
		case "":
		default:
			return fmt.Errorf("unknown policy type %q", part)
		}
	}
	*t = out
	return nil
}

// RuleID names one rule within one policy. It is stable across evaluations of an
// unchanged object, which is what lets the UI trace a graph edge back to the
// line of YAML that produced it.
type RuleID string

// NewRuleID builds a rule identifier of the form
// "networking.k8s.io/NetworkPolicy/prod/api-allow#ingress[2]".
func NewRuleID(policy ObjectRef, dir Direction, index int) RuleID {
	return RuleID(fmt.Sprintf("%s#%s[%d]", policy, dir, index))
}

// Policy is the normalized form every provider translates into.
type Policy struct {
	Ref      ObjectRef   `json:"ref"`
	Provider string      `json:"provider"`
	Selector Selector    `json:"-"`
	Types    PolicyTypes `json:"types"`
	Ingress  []Rule      `json:"ingress,omitempty"`
	Egress   []Rule      `json:"egress,omitempty"`

	// Order is rule precedence for providers that have it. Kubernetes
	// NetworkPolicy and AWS ApplicationNetworkPolicy are purely additive allow
	// models, so it is always 0 for them; Cilium and Calico will use it.
	Order int `json:"order,omitempty"`

	// Raw is the original object, retained for the YAML viewer.
	Raw any `json:"-"`
}

// Rules returns the rules for one direction.
func (p Policy) Rules(d Direction) []Rule {
	if d == DirEgress {
		return p.Egress
	}
	return p.Ingress
}

// Rule is one entry of a policy's ingress or egress list.
//
// The AllPeers and AllPorts flags exist because the Kubernetes API expresses
// "unrestricted" as an absent-or-empty list, and a nil slice is too easy to lose
// in a copy or a round-trip. Making it a flag makes the semantics survive.
type Rule struct {
	ID   RuleID `json:"id"`
	Path string `json:"path"` // e.g. "spec.ingress[2]", for UI highlighting

	// AllPeers is set when from/to was empty or omitted, which the API defines
	// as matching every peer. When false, Peers are OR-ed together.
	AllPeers bool   `json:"allPeers"`
	Peers    []Peer `json:"peers,omitempty"`

	// AllPorts is set when ports was empty or omitted: every port, every
	// protocol. When false, Ports are OR-ed together.
	AllPorts bool        `json:"allPorts"`
	Ports    []PortRange `json:"ports,omitempty"`
}

// PeerKind discriminates the Peer union.
type PeerKind int

const (
	// PeerInvalid is the zero value and never appears in a well-formed model.
	PeerInvalid PeerKind = iota
	// PeerAny matches every possible source or destination. Only produced when
	// resolving a rule whose AllPeers flag is set.
	PeerAny
	// PeerPods is a namespaceSelector and/or podSelector.
	PeerPods
	// PeerCIDR is an ipBlock.
	PeerCIDR
	// PeerDomain is an AWS ApplicationNetworkPolicy domain name. Egress only.
	PeerDomain
)

// displayAny is the label for a peer that matches everything. It appears in
// PeerKind.String, in resolved peers, and in the graph node the UI draws for it,
// so the three cannot drift apart.
const displayAny = "any"

func (k PeerKind) String() string {
	switch k {
	case PeerAny:
		return displayAny
	case PeerPods:
		return "pods"
	case PeerCIDR:
		return "cidr"
	case PeerDomain:
		return "domain"
	default:
		return "invalid"
	}
}

// Peer is one entry of a rule's from/to list.
//
// Within a single Peer, NamespaceSelector and PodSelector are AND-ed. Separate
// Peers in the same Rule are OR-ed. Conflating those two is the most common way
// to write a policy that is far more permissive than intended, so the model
// keeps them structurally distinct.
type Peer struct {
	Kind PeerKind `json:"kind"`
	Path string   `json:"path"` // e.g. "spec.egress[0].to[1]"

	// NamespaceSelector nil means "the policy's own namespace"; non-nil but
	// empty means "all namespaces". PodSelector nil means "all pods in the
	// selected namespaces".
	NamespaceSelector *Selector `json:"-"`
	PodSelector       *Selector `json:"-"`

	CIDR   netip.Prefix   `json:"cidr,omitempty"`
	Except []netip.Prefix `json:"except,omitempty"`

	// Domain may be an exact name or a "*."-prefixed wildcard. See domain.go for
	// the matching rules, which the AWS CRD defines more broadly than a typical
	// glob: "*" spans one or more whole labels.
	Domain string `json:"domain,omitempty"`
}

// PortRange is one entry of a rule's ports list, expanded to an inclusive range.
type PortRange struct {
	Protocol Protocol `json:"protocol"`

	// AllPorts is set when the entry named a protocol but no port, which matches
	// every port of that protocol.
	AllPorts bool `json:"allPorts,omitempty"`

	// Name is set when the policy referenced a container port by name. From and
	// To are then zero until resolved against the relevant pods; a named port
	// with no matching container port legitimately matches nothing.
	Name string `json:"name,omitempty"`

	From int32 `json:"from,omitempty"`
	To   int32 `json:"to,omitempty"` // inclusive; equals From when endPort is absent
}

func (p PortRange) String() string {
	proto := string(p.Protocol)
	switch {
	case p.AllPorts:
		return "*/" + proto
	case p.Name != "" && p.From == 0:
		return p.Name + "/" + proto + " (unresolved)"
	case p.Name != "":
		return fmt.Sprintf("%s=%d/%s", p.Name, p.From, proto)
	case p.To > p.From:
		return fmt.Sprintf("%d-%d/%s", p.From, p.To, proto)
	default:
		return fmt.Sprintf("%d/%s", p.From, proto)
	}
}

// bounds returns the inclusive numeric range this entry covers. ok is false when
// the entry matches nothing, which happens for an unresolved named port.
func (p PortRange) bounds() (from, to int32, ok bool) {
	if p.AllPorts {
		return 1, 65535, true
	}
	if p.From <= 0 {
		return 0, 0, false
	}
	to = p.To
	if to < p.From {
		to = p.From
	}
	return p.From, to, true
}
