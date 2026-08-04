// Package awsanp normalizes AWS VPC CNI ApplicationNetworkPolicy objects
// (networking.k8s.aws/v1alpha1) into the npeval model.
//
// The CRD's distinguishing feature is domain-based egress: an egress peer may
// carry domainNames instead of selectors or an ipBlock. Everything else is the
// upstream NetworkPolicy schema, so this package reuses the k8s provider's
// helpers rather than duplicating their edge cases.
//
// ApplicationNetworkPolicy forms its own evaluation layer. Per the CRD's field
// documentation, traffic is permitted when no ANP selects the pod "and cluster
// policy otherwise allows the traffic" — it does not add rules to the same pool
// as NetworkPolicy. npeval.CombineMode governs how the layers meet.
package awsanp

import (
	"fmt"
	"regexp"

	"k8s.io/apimachinery/pkg/runtime/schema"

	awsv1alpha1 "github.com/FathiQ/marsad/pkg/apis/awsanp/v1alpha1"
	"github.com/FathiQ/marsad/pkg/npeval"
	"github.com/FathiQ/marsad/pkg/npeval/provider/k8s"
)

// Name is the provider and layer identifier.
const Name = "aws-anp"

// Group and Kind identify the objects this provider handles.
const (
	Group = awsv1alpha1.GroupName
	Kind  = awsv1alpha1.Kind
)

// domainPattern is the CRD's own validation pattern for a domain name, copied
// verbatim so that Marsad rejects exactly what the API server would.
var domainPattern = regexp.MustCompile(
	`^(\*\.)?([a-zA-z0-9]([-a-zA-Z0-9_]*[a-zA-Z0-9])?\.)+[a-zA-z0-9]([-a-zA-Z0-9_]*[a-zA-Z0-9])?\.?$`)

// Provider implements npeval.Provider for ApplicationNetworkPolicy.
type Provider struct{}

var _ npeval.Provider = Provider{}

// Name returns the layer identifier.
func (Provider) Name() string { return Name }

// GVR returns the resource the watch layer lists and watches.
func (Provider) GVR() schema.GroupVersionResource {
	return schema.GroupVersionResource{
		Group:    Group,
		Version:  awsv1alpha1.Version,
		Resource: "applicationnetworkpolicies",
	}
}

// Capabilities reports domain support only. The CRD states FQDN rules are
// allow-only and do not support deny semantics, so like NetworkPolicy this is an
// additive model — it just adds domain peers.
func (Provider) Capabilities() npeval.Capabilities {
	return npeval.Capabilities{Domains: true}
}

// Normalize converts one native policy object into normalized policies.
func (Provider) Normalize(obj any) ([]npeval.Policy, error) {
	anp, ok := obj.(*awsv1alpha1.ApplicationNetworkPolicy)
	if !ok {
		return nil, fmt.Errorf("aws-anp provider: expected *v1alpha1.ApplicationNetworkPolicy, got %T", obj)
	}
	p, err := NormalizePolicy(anp)
	if err != nil {
		return nil, err
	}
	return []npeval.Policy{p}, nil
}

// NormalizePolicy converts one ApplicationNetworkPolicy.
func NormalizePolicy(anp *awsv1alpha1.ApplicationNetworkPolicy) (npeval.Policy, error) {
	if anp == nil {
		return npeval.Policy{}, fmt.Errorf("nil ApplicationNetworkPolicy")
	}
	ref := npeval.ObjectRef{Group: Group, Kind: Kind, Namespace: anp.Namespace, Name: anp.Name}

	sel, err := npeval.NewSelector(&anp.Spec.PodSelector)
	if err != nil {
		return npeval.Policy{}, fmt.Errorf("%s: spec.podSelector: %w", ref, err)
	}

	p := npeval.Policy{
		Ref:      ref,
		Provider: Name,
		Selector: sel,
		Types:    k8s.PolicyTypes(anp.Spec.PolicyTypes, len(anp.Spec.Egress) > 0),
		Raw:      anp,
	}

	if p.Ingress, err = k8s.NormalizeIngressRules(ref, anp.Spec.Ingress); err != nil {
		return npeval.Policy{}, err
	}

	for i, r := range anp.Spec.Egress {
		path := fmt.Sprintf("spec.egress[%d]", i)
		rule := npeval.Rule{
			ID:       npeval.NewRuleID(ref, npeval.DirEgress, i),
			Path:     path,
			AllPeers: len(r.To) == 0,
			AllPorts: len(r.Ports) == 0,
		}
		for j, peer := range r.To {
			peers, err := normalizeEgressPeer(peer, fmt.Sprintf("%s.to[%d]", path, j))
			if err != nil {
				return npeval.Policy{}, fmt.Errorf("%s: %w", ref, err)
			}
			rule.Peers = append(rule.Peers, peers...)
		}
		if rule.Ports, err = k8s.NormalizePorts(r.Ports, path); err != nil {
			return npeval.Policy{}, fmt.Errorf("%s: %w", ref, err)
		}
		p.Egress = append(p.Egress, rule)
	}

	return p, nil
}

// normalizeEgressPeer converts one ANP egress peer, expanding domainNames into
// one peer per name.
//
// The expansion is what gives the graph a separate cloud node per domain while
// keeping traceability exact: each peer keeps the index of the name it came
// from, so clicking an edge points at spec.egress[i].to[j].domainNames[k].
func normalizeEgressPeer(peer awsv1alpha1.ApplicationNetworkPolicyPeer, path string) ([]npeval.Peer, error) {
	hasSelector := peer.PodSelector != nil || peer.NamespaceSelector != nil
	hasDomains := len(peer.DomainNames) > 0

	if hasDomains {
		// Mirror the CRD's CEL validations rather than guessing at intent.
		switch {
		case peer.IPBlock != nil:
			return nil, fmt.Errorf("%s: ipBlock and domainNames are mutually exclusive", path)
		case peer.PodSelector != nil:
			return nil, fmt.Errorf("%s: podSelector and domainNames are mutually exclusive", path)
		case peer.NamespaceSelector != nil:
			return nil, fmt.Errorf("%s: namespaceSelector and domainNames are mutually exclusive", path)
		}

		out := make([]npeval.Peer, 0, len(peer.DomainNames))
		for k, d := range peer.DomainNames {
			where := fmt.Sprintf("%s.domainNames[%d]", path, k)
			if !domainPattern.MatchString(d) {
				return nil, fmt.Errorf("%s: %q is not a valid domain name", where, d)
			}
			out = append(out, npeval.Peer{
				Kind:   npeval.PeerDomain,
				Path:   where,
				Domain: npeval.NormalizeDomain(d),
			})
		}
		return out, nil
	}

	if peer.IPBlock != nil {
		if hasSelector {
			return nil, fmt.Errorf("%s: ipBlock cannot be combined with podSelector or namespaceSelector", path)
		}
		p, err := k8s.NormalizeIPBlock(peer.IPBlock, path)
		if err != nil {
			return nil, err
		}
		return []npeval.Peer{p}, nil
	}

	if !hasSelector {
		return nil, fmt.Errorf("%s: peer sets none of domainNames, ipBlock, podSelector or namespaceSelector", path)
	}

	out := npeval.Peer{Kind: npeval.PeerPods, Path: path}
	if peer.NamespaceSelector != nil {
		s, err := npeval.NewSelector(peer.NamespaceSelector)
		if err != nil {
			return nil, fmt.Errorf("%s.namespaceSelector: %w", path, err)
		}
		out.NamespaceSelector = &s
	}
	if peer.PodSelector != nil {
		s, err := npeval.NewSelector(peer.PodSelector)
		if err != nil {
			return nil, fmt.Errorf("%s.podSelector: %w", path, err)
		}
		out.PodSelector = &s
	}
	return []npeval.Peer{out}, nil
}
