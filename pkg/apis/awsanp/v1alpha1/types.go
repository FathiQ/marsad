// Package v1alpha1 contains Go types for the AWS VPC CNI
// ApplicationNetworkPolicy CRD (networking.k8s.aws/v1alpha1).
//
// AWS does not publish these as an importable Go module, so they are defined
// here, transcribed from the CRD's OpenAPI schema as installed by the
// amazon-network-policy-controller-k8s controller. Ingress rules, ports and
// ipBlock reuse the upstream networking.k8s.io/v1 types verbatim, because the
// CRD schema is byte-for-byte the upstream schema for those fields — only the
// egress peer differs, by adding domainNames.
package v1alpha1

import (
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GroupName is the API group of the CRD.
const GroupName = "networking.k8s.aws"

// Version is the served and stored version.
const Version = "v1alpha1"

// Kind is the CRD kind.
const Kind = "ApplicationNetworkPolicy"

// ApplicationNetworkPolicy is the AWS VPC CNI policy type that adds
// domain-based egress to the standard NetworkPolicy model.
type ApplicationNetworkPolicy struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   ApplicationNetworkPolicySpec   `json:"spec,omitempty"`
	Status ApplicationNetworkPolicyStatus `json:"status,omitempty"`
}

// ApplicationNetworkPolicyList is a list of ApplicationNetworkPolicy.
type ApplicationNetworkPolicyList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []ApplicationNetworkPolicy `json:"items"`
}

// ApplicationNetworkPolicySpec is the desired state.
//
// Note that PodSelector is required here, unlike NetworkPolicy where it is
// optional and defaults to selecting every pod.
type ApplicationNetworkPolicySpec struct {
	PodSelector metav1.LabelSelector `json:"podSelector"`

	// Ingress uses the upstream rule type: domain peers are egress-only.
	Ingress []networkingv1.NetworkPolicyIngressRule `json:"ingress,omitempty"`

	Egress []ApplicationNetworkPolicyEgressRule `json:"egress,omitempty"`

	// PolicyTypes defaults from the presence of ingress and egress rules,
	// exactly as NetworkPolicy does.
	PolicyTypes []networkingv1.PolicyType `json:"policyTypes,omitempty"`
}

// ApplicationNetworkPolicyEgressRule allows traffic out of the selected pods.
// Traffic must match both Ports and To.
type ApplicationNetworkPolicyEgressRule struct {
	Ports []networkingv1.NetworkPolicyPort `json:"ports,omitempty"`
	To    []ApplicationNetworkPolicyPeer   `json:"to,omitempty"`
}

// ApplicationNetworkPolicyPeer is an egress destination.
//
// The CRD enforces by CEL validation that DomainNames is mutually exclusive with
// PodSelector, NamespaceSelector and IPBlock.
type ApplicationNetworkPolicyPeer struct {
	PodSelector       *metav1.LabelSelector `json:"podSelector,omitempty"`
	NamespaceSelector *metav1.LabelSelector `json:"namespaceSelector,omitempty"`
	IPBlock           *networkingv1.IPBlock `json:"ipBlock,omitempty"`

	// DomainNames are FQDN peers. Allow-only: the CRD states FQDN rules do not
	// support deny semantics. A name is either exact or "*."-prefixed, where the
	// wildcard matches one or more whole labels.
	DomainNames []string `json:"domainNames,omitempty"`
}

// ApplicationNetworkPolicyStatus is the observed state.
type ApplicationNetworkPolicyStatus struct {
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}
