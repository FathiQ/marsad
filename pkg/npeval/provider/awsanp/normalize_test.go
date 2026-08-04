package awsanp_test

import (
	"strings"
	"testing"

	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	awsv1alpha1 "github.com/FathiQ/marsad/pkg/apis/awsanp/v1alpha1"
	"github.com/FathiQ/marsad/pkg/npeval"
	"github.com/FathiQ/marsad/pkg/npeval/provider/awsanp"
)

func anp(spec awsv1alpha1.ApplicationNetworkPolicySpec) *awsv1alpha1.ApplicationNetworkPolicy {
	return &awsv1alpha1.ApplicationNetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Namespace: "prod", Name: "egress"},
		Spec:       spec,
	}
}

func egressTo(peers ...awsv1alpha1.ApplicationNetworkPolicyPeer) awsv1alpha1.ApplicationNetworkPolicySpec {
	return awsv1alpha1.ApplicationNetworkPolicySpec{
		PodSelector: metav1.LabelSelector{MatchLabels: map[string]string{"app": "api"}},
		PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
		Egress:      []awsv1alpha1.ApplicationNetworkPolicyEgressRule{{To: peers}},
	}
}

// domainNames is a list per peer, so one peer becomes several graph nodes while
// each keeps the index it came from for traceability.
func TestDomainNamesExpandToOnePeerEach(t *testing.T) {
	p, err := awsanp.NormalizePolicy(anp(egressTo(awsv1alpha1.ApplicationNetworkPolicyPeer{
		DomainNames: []string{"*.s3.me-south-1.amazonaws.com", "STS.Amazonaws.com."},
	})))
	if err != nil {
		t.Fatal(err)
	}

	peers := p.Egress[0].Peers
	if len(peers) != 2 {
		t.Fatalf("got %d peers, want one per domain", len(peers))
	}
	for i, want := range []string{"*.s3.me-south-1.amazonaws.com", "sts.amazonaws.com"} {
		if peers[i].Kind != npeval.PeerDomain {
			t.Errorf("peer %d kind = %v", i, peers[i].Kind)
		}
		// Case and the trailing dot the CRD pattern permits are normalized away,
		// so two spellings of one domain become one graph node.
		if peers[i].Domain != want {
			t.Errorf("peer %d domain = %q, want %q", i, peers[i].Domain, want)
		}
	}
	if peers[0].Path != "spec.egress[0].to[0].domainNames[0]" {
		t.Errorf("path = %q, want the domain index", peers[0].Path)
	}
	if peers[1].Path != "spec.egress[0].to[0].domainNames[1]" {
		t.Errorf("path = %q", peers[1].Path)
	}
}

// The CRD enforces these with CEL validations. Marsad mirrors them rather than
// guessing what a rejected object was supposed to mean.
func TestDomainNamesAreMutuallyExclusive(t *testing.T) {
	tests := []struct {
		name string
		peer awsv1alpha1.ApplicationNetworkPolicyPeer
		want string
	}{
		{
			"with ipBlock",
			awsv1alpha1.ApplicationNetworkPolicyPeer{
				DomainNames: []string{"s3.amazonaws.com"},
				IPBlock:     &networkingv1.IPBlock{CIDR: "10.0.0.0/8"},
			},
			"ipBlock and domainNames are mutually exclusive",
		},
		{
			"with podSelector",
			awsv1alpha1.ApplicationNetworkPolicyPeer{
				DomainNames: []string{"s3.amazonaws.com"},
				PodSelector: &metav1.LabelSelector{},
			},
			"podSelector and domainNames are mutually exclusive",
		},
		{
			"with namespaceSelector",
			awsv1alpha1.ApplicationNetworkPolicyPeer{
				DomainNames:       []string{"s3.amazonaws.com"},
				NamespaceSelector: &metav1.LabelSelector{},
			},
			"namespaceSelector and domainNames are mutually exclusive",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := awsanp.NormalizePolicy(anp(egressTo(tt.peer)))
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("got %q, want %q", err, tt.want)
			}
		})
	}
}

// The pattern is copied from the CRD so Marsad rejects exactly what the API
// server would.
func TestDomainNameValidation(t *testing.T) {
	valid := []string{
		"kubernetes.io",
		"blog.kubernetes.io",
		"*.kubernetes.io",
		"*.s3.me-south-1.amazonaws.com",
		"kubernetes.io.",
		"my-service.example.com",
	}
	for _, d := range valid {
		t.Run("valid/"+d, func(t *testing.T) {
			if _, err := awsanp.NormalizePolicy(anp(egressTo(
				awsv1alpha1.ApplicationNetworkPolicyPeer{DomainNames: []string{d}}))); err != nil {
				t.Errorf("%q should be valid: %v", d, err)
			}
		})
	}

	invalid := []string{
		"*",                  // no domain at all
		"kubernetes",         // single label
		"my-*.kubernetes.io", // partial-label wildcards are not supported
		"*.*.kubernetes.io",  // only one wildcard, only as a prefix
		"kubernetes.*",       // wildcard must be a prefix
		"",
	}
	for _, d := range invalid {
		t.Run("invalid/"+d, func(t *testing.T) {
			if _, err := awsanp.NormalizePolicy(anp(egressTo(
				awsv1alpha1.ApplicationNetworkPolicyPeer{DomainNames: []string{d}}))); err == nil {
				t.Errorf("%q should be rejected", d)
			}
		})
	}
}

// Domain peers are egress-only: the CRD's ingress rules are the upstream type.
func TestIngressUsesTheUpstreamRuleType(t *testing.T) {
	p, err := awsanp.NormalizePolicy(anp(awsv1alpha1.ApplicationNetworkPolicySpec{
		PodSelector: metav1.LabelSelector{},
		PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
		Ingress: []networkingv1.NetworkPolicyIngressRule{{
			From: []networkingv1.NetworkPolicyPeer{{PodSelector: &metav1.LabelSelector{}}},
		}},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if got := p.Ingress[0].Peers[0].Kind; got != npeval.PeerPods {
		t.Errorf("got %v, want a pods peer", got)
	}
	if p.Ingress[0].ID != "networking.k8s.aws/ApplicationNetworkPolicy/prod/egress#ingress[0]" {
		t.Errorf("rule id = %q", p.Ingress[0].ID)
	}
}

func TestNonDomainPeersStillWork(t *testing.T) {
	t.Run("ipBlock", func(t *testing.T) {
		p, err := awsanp.NormalizePolicy(anp(egressTo(awsv1alpha1.ApplicationNetworkPolicyPeer{
			IPBlock: &networkingv1.IPBlock{CIDR: "10.0.0.0/8", Except: []string{"10.1.0.0/16"}},
		})))
		if err != nil {
			t.Fatal(err)
		}
		peer := p.Egress[0].Peers[0]
		if peer.Kind != npeval.PeerCIDR || peer.CIDR.String() != "10.0.0.0/8" || len(peer.Except) != 1 {
			t.Errorf("got %+v", peer)
		}
	})

	t.Run("selectors", func(t *testing.T) {
		p, err := awsanp.NormalizePolicy(anp(egressTo(awsv1alpha1.ApplicationNetworkPolicyPeer{
			NamespaceSelector: &metav1.LabelSelector{},
			PodSelector:       &metav1.LabelSelector{MatchLabels: map[string]string{"app": "db"}},
		})))
		if err != nil {
			t.Fatal(err)
		}
		peer := p.Egress[0].Peers[0]
		if peer.Kind != npeval.PeerPods || peer.NamespaceSelector == nil || peer.PodSelector == nil {
			t.Errorf("got %+v", peer)
		}
	})

	t.Run("an empty peer is rejected", func(t *testing.T) {
		_, err := awsanp.NormalizePolicy(anp(egressTo(awsv1alpha1.ApplicationNetworkPolicyPeer{})))
		if err == nil || !strings.Contains(err.Error(), "none of") {
			t.Errorf("got %v", err)
		}
	})
}

func TestPolicyTypesDefaultingMatchesNetworkPolicy(t *testing.T) {
	p, err := awsanp.NormalizePolicy(anp(awsv1alpha1.ApplicationNetworkPolicySpec{
		PodSelector: metav1.LabelSelector{},
		Egress: []awsv1alpha1.ApplicationNetworkPolicyEgressRule{{
			To: []awsv1alpha1.ApplicationNetworkPolicyPeer{{DomainNames: []string{"s3.amazonaws.com"}}},
		}},
	}))
	if err != nil {
		t.Fatal(err)
	}
	// Same footgun as NetworkPolicy: an egress-only ANP with no policyTypes also
	// denies all ingress.
	if !p.Types.Has(npeval.TypeIngress) || !p.Types.Has(npeval.TypeEgress) {
		t.Errorf("got %v, want both directions", p.Types)
	}
}

func TestProviderContract(t *testing.T) {
	var p awsanp.Provider

	if p.Name() != "aws-anp" {
		t.Errorf("name = %q", p.Name())
	}
	gvr := p.GVR()
	if gvr.Group != "networking.k8s.aws" || gvr.Version != "v1alpha1" || gvr.Resource != "applicationnetworkpolicies" {
		t.Errorf("gvr = %+v", gvr)
	}
	// The CRD states FQDN rules are allow-only, so this stays an additive model
	// that merely adds domain peers.
	want := npeval.Capabilities{Domains: true}
	if got := p.Capabilities(); got != want {
		t.Errorf("capabilities = %+v, want %+v", got, want)
	}

	if _, err := p.Normalize("not a policy"); err == nil {
		t.Error("expected an error for the wrong type")
	}
}
