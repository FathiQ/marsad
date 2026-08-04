package npeval

import "k8s.io/apimachinery/pkg/runtime/schema"

// Capabilities declares what a provider's policy language can express, so the UI
// can be honest about what it is and is not showing.
type Capabilities struct {
	// DenyRules is true when the language has explicit deny, which makes rule
	// order significant. Kubernetes NetworkPolicy and AWS
	// ApplicationNetworkPolicy are additive allow-only; Cilium and Calico are not.
	DenyRules bool
	// Ordering is true when Policy.Order is meaningful.
	Ordering bool
	// Domains is true when the provider can emit PeerDomain.
	Domains bool
	// Layer7 is true when the language has L7 rules that npeval does not model.
	// The UI must surface this as a caveat rather than implying the graph is
	// complete.
	Layer7 bool
}

// Provider translates one vendor's policy type into the normalized model.
//
// Adding Cilium or Calico support means adding a Provider, not touching the
// evaluator: rules from each provider form an independent layer (see
// CombineMode), which is also how their deny semantics will be kept from leaking
// into the additive Kubernetes model.
type Provider interface {
	// Name identifies the layer, e.g. "k8s" or "aws-anp".
	Name() string

	// GVR is the resource the watch layer must list and watch. It is also what
	// the server checks against the discovery API to decide whether this
	// provider is available on the cluster at all.
	GVR() schema.GroupVersionResource

	// Capabilities describes the policy language.
	Capabilities() Capabilities

	// Normalize converts one native policy object into normalized policies.
	// It takes any so that the core never imports k8s.io/api; implementations
	// type-assert. Malformed input is an error, never a silent guess.
	Normalize(obj any) ([]Policy, error)
}
