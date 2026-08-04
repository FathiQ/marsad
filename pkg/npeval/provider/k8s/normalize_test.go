package k8s_test

import (
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"

	"github.com/FathiQ/marsad/pkg/npeval"
	"github.com/FathiQ/marsad/pkg/npeval/provider/k8s"
)

func np(spec networkingv1.NetworkPolicySpec) *networkingv1.NetworkPolicy {
	return &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Namespace: "prod", Name: "p"},
		Spec:       spec,
	}
}

func portNum(n int32) *intstr.IntOrString { v := intstr.FromInt32(n); return &v }
func portName(s string) *intstr.IntOrString {
	v := intstr.FromString(s)
	return &v
}
func i32(n int32) *int32                       { return &n }
func proto(p corev1.Protocol) *corev1.Protocol { return &p }

// policyTypes defaulting is the rule most often misremembered: an unset list
// means Ingress, plus Egress only when the policy actually has egress rules.
func TestPolicyTypesDefaulting(t *testing.T) {
	tests := []struct {
		name     string
		declared []networkingv1.PolicyType
		hasEgres bool
		want     npeval.PolicyTypes
	}{
		{"unset with no egress rules", nil, false, npeval.TypeIngress},
		{"unset with egress rules", nil, true, npeval.TypeIngress | npeval.TypeEgress},
		{"explicit ingress", []networkingv1.PolicyType{networkingv1.PolicyTypeIngress}, false, npeval.TypeIngress},
		{
			"explicit egress only, even with no egress rules",
			[]networkingv1.PolicyType{networkingv1.PolicyTypeEgress}, false, npeval.TypeEgress,
		},
		{
			"both",
			[]networkingv1.PolicyType{networkingv1.PolicyTypeIngress, networkingv1.PolicyTypeEgress},
			true, npeval.TypeIngress | npeval.TypeEgress,
		},
		{"empty list falls back to defaulting", []networkingv1.PolicyType{}, true, npeval.TypeIngress | npeval.TypeEgress},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := k8s.PolicyTypes(tt.declared, tt.hasEgres); got != tt.want {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}

func TestNormalizePorts(t *testing.T) {
	t.Run("a plain port becomes a single-value range", func(t *testing.T) {
		got, err := k8s.NormalizePorts([]networkingv1.NetworkPolicyPort{{Port: portNum(443)}}, "spec.ingress[0]")
		if err != nil {
			t.Fatal(err)
		}
		want := npeval.PortRange{Protocol: npeval.ProtocolTCP, From: 443, To: 443}
		if got[0] != want {
			t.Errorf("got %+v, want %+v", got[0], want)
		}
	})

	t.Run("endPort makes an inclusive range", func(t *testing.T) {
		got, err := k8s.NormalizePorts(
			[]networkingv1.NetworkPolicyPort{{Port: portNum(8000), EndPort: i32(9000)}}, "spec.ingress[0]")
		if err != nil {
			t.Fatal(err)
		}
		if got[0].From != 8000 || got[0].To != 9000 {
			t.Errorf("got %+v", got[0])
		}
	})

	t.Run("a protocol with no port covers every port", func(t *testing.T) {
		got, err := k8s.NormalizePorts(
			[]networkingv1.NetworkPolicyPort{{Protocol: proto(corev1.ProtocolSCTP)}}, "spec.ingress[0]")
		if err != nil {
			t.Fatal(err)
		}
		if !got[0].AllPorts || got[0].Protocol != npeval.ProtocolSCTP {
			t.Errorf("got %+v", got[0])
		}
	})

	t.Run("a named port keeps its name for later resolution", func(t *testing.T) {
		got, err := k8s.NormalizePorts([]networkingv1.NetworkPolicyPort{{Port: portName("http")}}, "spec.ingress[0]")
		if err != nil {
			t.Fatal(err)
		}
		if got[0].Name != "http" || got[0].From != 0 {
			t.Errorf("got %+v, want an unresolved named entry", got[0])
		}
	})

	invalid := []struct {
		name  string
		ports []networkingv1.NetworkPolicyPort
		want  string
	}{
		{
			"endPort with a named port",
			[]networkingv1.NetworkPolicyPort{{Port: portName("http"), EndPort: i32(9000)}},
			"named port",
		},
		{
			"endPort with no port",
			[]networkingv1.NetworkPolicyPort{{EndPort: i32(9000)}},
			"without port",
		},
		{
			"endPort below port",
			[]networkingv1.NetworkPolicyPort{{Port: portNum(9000), EndPort: i32(8000)}},
			"less than port",
		},
		{
			"port out of range",
			[]networkingv1.NetworkPolicyPort{{Port: portNum(70000)}},
			"out of range",
		},
		{
			"unknown protocol",
			[]networkingv1.NetworkPolicyPort{{Protocol: proto(corev1.Protocol("QUIC")), Port: portNum(443)}},
			"unknown protocol",
		},
	}
	for _, tt := range invalid {
		t.Run(tt.name+" is rejected", func(t *testing.T) {
			_, err := k8s.NormalizePorts(tt.ports, "spec.ingress[0]")
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("got %q, want it to mention %q", err, tt.want)
			}
		})
	}
}

// Malformed policy is reported, never guessed at: a tool that silently
// reinterprets a broken rule is worse than one that says it cannot read it.
func TestNormalizeRejectsInvalidPeers(t *testing.T) {
	tests := []struct {
		name string
		peer networkingv1.NetworkPolicyPeer
		want string
	}{
		{
			"ipBlock combined with podSelector",
			networkingv1.NetworkPolicyPeer{
				IPBlock:     &networkingv1.IPBlock{CIDR: "10.0.0.0/8"},
				PodSelector: &metav1.LabelSelector{},
			},
			"cannot be combined",
		},
		{
			"an entirely empty peer",
			networkingv1.NetworkPolicyPeer{},
			"none of",
		},
		{
			"an unparseable cidr",
			networkingv1.NetworkPolicyPeer{IPBlock: &networkingv1.IPBlock{CIDR: "not-a-cidr"}},
			"cidr",
		},
		{
			"an except outside the block",
			networkingv1.NetworkPolicyPeer{IPBlock: &networkingv1.IPBlock{
				CIDR: "10.0.0.0/8", Except: []string{"192.168.0.0/16"},
			}},
			"outside",
		},
		{
			"an except broader than the block",
			networkingv1.NetworkPolicyPeer{IPBlock: &networkingv1.IPBlock{
				CIDR: "10.1.0.0/16", Except: []string{"10.0.0.0/8"},
			}},
			"outside",
		},
		{
			"mismatched address families",
			networkingv1.NetworkPolicyPeer{IPBlock: &networkingv1.IPBlock{
				CIDR: "10.0.0.0/8", Except: []string{"2001:db8::/64"},
			}},
			"different IP families",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := k8s.NormalizePeer(tt.peer, "spec.ingress[0].from[0]")
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("got %q, want it to mention %q", err, tt.want)
			}
			if !strings.Contains(err.Error(), "spec.ingress[0].from[0]") {
				t.Errorf("got %q, want the field path for the UI", err)
			}
		})
	}
}

func TestNormalizeIPBlockMasksTheAddress(t *testing.T) {
	// 10.1.2.3/8 is accepted by the API server; storing it unmasked would make
	// two spellings of the same block compare unequal.
	peer, err := k8s.NormalizePeer(
		networkingv1.NetworkPolicyPeer{IPBlock: &networkingv1.IPBlock{CIDR: "10.1.2.3/8"}},
		"spec.egress[0].to[0]")
	if err != nil {
		t.Fatal(err)
	}
	if got := peer.CIDR.String(); got != "10.0.0.0/8" {
		t.Errorf("got %q, want 10.0.0.0/8", got)
	}
}

// Rule identifiers and field paths are what let the UI trace a graph edge back
// to the YAML that produced it, so they are part of the contract.
func TestRuleIDsAndPathsAreStable(t *testing.T) {
	p, err := k8s.NormalizePolicy(np(networkingv1.NetworkPolicySpec{
		PodSelector: metav1.LabelSelector{},
		PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress, networkingv1.PolicyTypeEgress},
		Ingress: []networkingv1.NetworkPolicyIngressRule{
			{From: []networkingv1.NetworkPolicyPeer{{PodSelector: &metav1.LabelSelector{}}}},
			{From: []networkingv1.NetworkPolicyPeer{{IPBlock: &networkingv1.IPBlock{CIDR: "10.0.0.0/8"}}}},
		},
		Egress: []networkingv1.NetworkPolicyEgressRule{
			{To: []networkingv1.NetworkPolicyPeer{{IPBlock: &networkingv1.IPBlock{CIDR: "0.0.0.0/0"}}}},
		},
	}))
	if err != nil {
		t.Fatal(err)
	}

	wantIngress := []npeval.RuleID{
		"networking.k8s.io/NetworkPolicy/prod/p#ingress[0]",
		"networking.k8s.io/NetworkPolicy/prod/p#ingress[1]",
	}
	for i, want := range wantIngress {
		if p.Ingress[i].ID != want {
			t.Errorf("ingress[%d] id = %q, want %q", i, p.Ingress[i].ID, want)
		}
	}
	if p.Egress[0].ID != "networking.k8s.io/NetworkPolicy/prod/p#egress[0]" {
		t.Errorf("egress id = %q", p.Egress[0].ID)
	}
	if p.Ingress[1].Peers[0].Path != "spec.ingress[1].from[0]" {
		t.Errorf("peer path = %q", p.Ingress[1].Peers[0].Path)
	}
	if p.Egress[0].Peers[0].Path != "spec.egress[0].to[0]" {
		t.Errorf("peer path = %q", p.Egress[0].Peers[0].Path)
	}
}

func TestProviderContract(t *testing.T) {
	var p k8s.Provider

	if p.Name() != "k8s" {
		t.Errorf("name = %q", p.Name())
	}
	if gvr := p.GVR(); gvr.Group != "networking.k8s.io" || gvr.Resource != "networkpolicies" {
		t.Errorf("gvr = %+v", gvr)
	}
	// NetworkPolicy is additive allow-only: no deny, no ordering, no domains.
	if got := p.Capabilities(); got != (npeval.Capabilities{}) {
		t.Errorf("capabilities = %+v, want all false", got)
	}

	policies, err := p.Normalize(np(networkingv1.NetworkPolicySpec{PodSelector: metav1.LabelSelector{}}))
	if err != nil {
		t.Fatal(err)
	}
	if len(policies) != 1 || policies[0].Provider != "k8s" {
		t.Errorf("got %+v", policies)
	}

	if _, err := p.Normalize("not a policy"); err == nil {
		t.Error("expected an error for the wrong type")
	}
}

func TestRawIsRetainedForTheYAMLViewer(t *testing.T) {
	in := np(networkingv1.NetworkPolicySpec{PodSelector: metav1.LabelSelector{}})
	p, err := k8s.NormalizePolicy(in)
	if err != nil {
		t.Fatal(err)
	}
	if p.Raw != any(in) {
		t.Error("Raw should point at the original object")
	}
}
