// Package k8s normalizes networking.k8s.io/v1 NetworkPolicy objects into the
// npeval model.
//
// Its exported helpers are also used by the AWS ApplicationNetworkPolicy
// provider, whose ingress rules, ports and ipBlock are the upstream types
// verbatim — only its egress peer differs.
package k8s

import (
	"fmt"
	"net/netip"

	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/intstr"

	"github.com/FathiQ/marsad/pkg/npeval"
)

// Name is the provider and layer identifier.
const Name = "k8s"

// Group and Kind identify the objects this provider handles.
const (
	Group = "networking.k8s.io"
	Kind  = "NetworkPolicy"
)

// Provider implements npeval.Provider for standard NetworkPolicy.
type Provider struct{}

var _ npeval.Provider = Provider{}

// Name returns the layer identifier.
func (Provider) Name() string { return Name }

// GVR returns the resource the watch layer lists and watches.
func (Provider) GVR() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: Group, Version: "v1", Resource: "networkpolicies"}
}

// Capabilities reports an empty set: NetworkPolicy is a purely additive allow
// model with no deny, no ordering, no domain peers and no L7.
func (Provider) Capabilities() npeval.Capabilities { return npeval.Capabilities{} }

// Normalize converts one native policy object into normalized policies.
func (Provider) Normalize(obj any) ([]npeval.Policy, error) {
	np, ok := obj.(*networkingv1.NetworkPolicy)
	if !ok {
		return nil, fmt.Errorf("k8s provider: expected *networkingv1.NetworkPolicy, got %T", obj)
	}
	p, err := NormalizePolicy(np)
	if err != nil {
		return nil, err
	}
	return []npeval.Policy{p}, nil
}

// NormalizePolicy converts one NetworkPolicy.
func NormalizePolicy(np *networkingv1.NetworkPolicy) (npeval.Policy, error) {
	if np == nil {
		return npeval.Policy{}, fmt.Errorf("nil NetworkPolicy")
	}
	ref := npeval.ObjectRef{Group: Group, Kind: Kind, Namespace: np.Namespace, Name: np.Name}

	sel, err := npeval.NewSelector(&np.Spec.PodSelector)
	if err != nil {
		return npeval.Policy{}, fmt.Errorf("%s: spec.podSelector: %w", ref, err)
	}

	p := npeval.Policy{
		Ref:      ref,
		Provider: Name,
		Selector: sel,
		Types:    PolicyTypes(np.Spec.PolicyTypes, len(np.Spec.Egress) > 0),
		Raw:      np,
	}

	p.Ingress, err = NormalizeIngressRules(ref, np.Spec.Ingress)
	if err != nil {
		return npeval.Policy{}, err
	}

	for i, r := range np.Spec.Egress {
		path := fmt.Sprintf("spec.egress[%d]", i)
		rule := npeval.Rule{
			ID:       npeval.NewRuleID(ref, npeval.DirEgress, i),
			Path:     path,
			AllPeers: len(r.To) == 0,
			AllPorts: len(r.Ports) == 0,
		}
		for j, peer := range r.To {
			pe, err := NormalizePeer(peer, fmt.Sprintf("%s.to[%d]", path, j))
			if err != nil {
				return npeval.Policy{}, fmt.Errorf("%s: %w", ref, err)
			}
			rule.Peers = append(rule.Peers, pe)
		}
		if rule.Ports, err = NormalizePorts(r.Ports, path); err != nil {
			return npeval.Policy{}, fmt.Errorf("%s: %w", ref, err)
		}
		p.Egress = append(p.Egress, rule)
	}

	return p, nil
}

// NormalizeIngressRules converts a list of upstream ingress rules. Shared with
// the AWS provider, whose ingress rules are the same type.
func NormalizeIngressRules(ref npeval.ObjectRef, rules []networkingv1.NetworkPolicyIngressRule) ([]npeval.Rule, error) {
	var out []npeval.Rule
	for i, r := range rules {
		path := fmt.Sprintf("spec.ingress[%d]", i)
		rule := npeval.Rule{
			ID:   npeval.NewRuleID(ref, npeval.DirIngress, i),
			Path: path,
			// An absent or empty from list means "all sources", per the API
			// field documentation — empty and missing are not distinguished
			// here. The nil-versus-empty distinction that does matter is one
			// level up, on spec.ingress itself.
			AllPeers: len(r.From) == 0,
			AllPorts: len(r.Ports) == 0,
		}
		for j, peer := range r.From {
			p, err := NormalizePeer(peer, fmt.Sprintf("%s.from[%d]", path, j))
			if err != nil {
				return nil, fmt.Errorf("%s: %w", ref, err)
			}
			rule.Peers = append(rule.Peers, p)
		}
		ports, err := NormalizePorts(r.Ports, path)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", ref, err)
		}
		rule.Ports = ports
		out = append(out, rule)
	}
	return out, nil
}

// PolicyTypes resolves the declared policyTypes, applying the API's defaulting:
// an unset list means Ingress, plus Egress if and only if the policy has egress
// rules.
func PolicyTypes(declared []networkingv1.PolicyType, hasEgressRules bool) npeval.PolicyTypes {
	if len(declared) == 0 {
		t := npeval.TypeIngress
		if hasEgressRules {
			t |= npeval.TypeEgress
		}
		return t
	}
	var t npeval.PolicyTypes
	for _, d := range declared {
		switch d {
		case networkingv1.PolicyTypeIngress:
			t |= npeval.TypeIngress
		case networkingv1.PolicyTypeEgress:
			t |= npeval.TypeEgress
		}
	}
	return t
}

// NormalizePeer converts one upstream peer.
func NormalizePeer(peer networkingv1.NetworkPolicyPeer, path string) (npeval.Peer, error) {
	hasSelector := peer.PodSelector != nil || peer.NamespaceSelector != nil

	if peer.IPBlock != nil {
		if hasSelector {
			return npeval.Peer{}, fmt.Errorf("%s: ipBlock cannot be combined with podSelector or namespaceSelector", path)
		}
		return NormalizeIPBlock(peer.IPBlock, path)
	}
	if !hasSelector {
		return npeval.Peer{}, fmt.Errorf("%s: peer sets none of ipBlock, podSelector or namespaceSelector", path)
	}

	out := npeval.Peer{Kind: npeval.PeerPods, Path: path}
	if peer.NamespaceSelector != nil {
		s, err := npeval.NewSelector(peer.NamespaceSelector)
		if err != nil {
			return npeval.Peer{}, fmt.Errorf("%s.namespaceSelector: %w", path, err)
		}
		out.NamespaceSelector = &s
	}
	if peer.PodSelector != nil {
		s, err := npeval.NewSelector(peer.PodSelector)
		if err != nil {
			return npeval.Peer{}, fmt.Errorf("%s.podSelector: %w", path, err)
		}
		out.PodSelector = &s
	}
	return out, nil
}

// NormalizeIPBlock converts an ipBlock, validating that every exception falls
// inside the block — the same rule the API server enforces.
func NormalizeIPBlock(b *networkingv1.IPBlock, path string) (npeval.Peer, error) {
	cidr, err := netip.ParsePrefix(b.CIDR)
	if err != nil {
		return npeval.Peer{}, fmt.Errorf("%s.ipBlock.cidr: %w", path, err)
	}
	cidr = cidr.Masked()

	out := npeval.Peer{Kind: npeval.PeerCIDR, Path: path, CIDR: cidr}
	for i, e := range b.Except {
		x, err := netip.ParsePrefix(e)
		if err != nil {
			return npeval.Peer{}, fmt.Errorf("%s.ipBlock.except[%d]: %w", path, i, err)
		}
		x = x.Masked()
		if x.Addr().Is4() != cidr.Addr().Is4() {
			return npeval.Peer{}, fmt.Errorf("%s.ipBlock.except[%d]: %s and %s are different IP families", path, i, x, cidr)
		}
		if x.Bits() < cidr.Bits() || !cidr.Contains(x.Addr()) {
			return npeval.Peer{}, fmt.Errorf("%s.ipBlock.except[%d]: %s is outside %s", path, i, x, cidr)
		}
		out.Except = append(out.Except, x)
	}
	return out, nil
}

// NormalizePorts converts a ports list into inclusive ranges.
func NormalizePorts(ports []networkingv1.NetworkPolicyPort, path string) ([]npeval.PortRange, error) {
	var out []npeval.PortRange
	for i, p := range ports {
		where := fmt.Sprintf("%s.ports[%d]", path, i)

		proto := npeval.ProtocolTCP // the API default
		if p.Protocol != nil {
			proto = npeval.Protocol(*p.Protocol)
		}
		switch proto {
		case npeval.ProtocolTCP, npeval.ProtocolUDP, npeval.ProtocolSCTP:
		default:
			return nil, fmt.Errorf("%s.protocol: unknown protocol %q", where, proto)
		}

		// No port at all: every port of this protocol.
		if p.Port == nil {
			if p.EndPort != nil {
				return nil, fmt.Errorf("%s.endPort: set without port", where)
			}
			out = append(out, npeval.PortRange{Protocol: proto, AllPorts: true})
			continue
		}

		if p.Port.Type == intstr.String {
			if p.EndPort != nil {
				return nil, fmt.Errorf("%s.endPort: cannot be combined with a named port %q", where, p.Port.StrVal)
			}
			out = append(out, npeval.PortRange{Protocol: proto, Name: p.Port.StrVal})
			continue
		}

		from := int32(p.Port.IntValue())
		if from < 1 || from > 65535 {
			return nil, fmt.Errorf("%s.port: %d out of range 1-65535", where, from)
		}
		to := from
		if p.EndPort != nil {
			to = *p.EndPort
			if to < from {
				return nil, fmt.Errorf("%s.endPort: %d is less than port %d", where, to, from)
			}
			if to > 65535 {
				return nil, fmt.Errorf("%s.endPort: %d out of range 1-65535", where, to)
			}
		}
		out = append(out, npeval.PortRange{Protocol: proto, From: from, To: to})
	}
	return out, nil
}
