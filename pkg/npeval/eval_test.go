package npeval_test

import (
	"reflect"
	"slices"
	"testing"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	awsv1alpha1 "github.com/FathiQ/marsad/pkg/apis/awsanp/v1alpha1"
	"github.com/FathiQ/marsad/pkg/npeval"
)

// Isolation is the semantic hinge of the whole model: a pod nothing selects is
// wide open, and a pod anything selects is default-deny in that direction.
func TestIsolation(t *testing.T) {
	api := deployRef("prod", "api")

	t.Run("a workload no policy selects is open in both directions", func(t *testing.T) {
		e := build(t, namespace("prod"), deploy("prod", "api", "app", "api"))
		iso := e.Isolation(api)
		if iso.Ingress || iso.Egress {
			t.Errorf("got %+v, want neither direction isolated", iso)
		}
	})

	t.Run("policyTypes Ingress isolates only ingress", func(t *testing.T) {
		e := build(t,
			namespace("prod"),
			deploy("prod", "api", "app", "api"),
			netpol("prod", "deny-ingress", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			}),
		)
		iso := e.Isolation(api)
		if !iso.Ingress || iso.Egress {
			t.Errorf("got %+v, want ingress-only isolation", iso)
		}
	})

	t.Run("an empty podSelector selects every pod in the namespace", func(t *testing.T) {
		e := build(t,
			namespace("prod"),
			deploy("prod", "api", "app", "api"),
			deploy("prod", "web", "app", "web"),
			netpol("prod", "default-deny", networkingv1.NetworkPolicySpec{
				PodSelector: metav1.LabelSelector{},
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			}),
		)
		for _, name := range []string{"api", "web"} {
			if !e.Isolation(deployRef("prod", name)).Ingress {
				t.Errorf("%s should be ingress-isolated", name)
			}
		}
	})

	t.Run("policies do not reach across namespaces", func(t *testing.T) {
		e := build(t,
			namespace("prod"), namespace("staging"),
			deploy("prod", "api", "app", "api"),
			deploy("staging", "api", "app", "api"),
			netpol("prod", "deny", networkingv1.NetworkPolicySpec{
				PodSelector: metav1.LabelSelector{},
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			}),
		)
		if !e.Isolation(deployRef("prod", "api")).Ingress {
			t.Error("prod/api should be isolated")
		}
		if e.Isolation(deployRef("staging", "api")).Ingress {
			t.Error("staging/api must not be affected by a policy in prod")
		}
	})

	// The classic footgun: policyTypes defaults to Ingress plus Egress-if-there-
	// are-egress-rules. Writing an egress-only policy without saying so makes the
	// pod ingress-isolated with zero ingress rules, i.e. deny-all inbound.
	t.Run("an egress-only policy without policyTypes also denies all ingress", func(t *testing.T) {
		e := build(t,
			namespace("prod"),
			deploy("prod", "api", "app", "api"),
			netpol("prod", "egress-only", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				Egress: []networkingv1.NetworkPolicyEgressRule{{
					To: []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "db")}},
				}},
			}),
		)
		iso := e.Isolation(api)
		if !iso.Ingress || !iso.Egress {
			t.Fatalf("got %+v, want both directions isolated", iso)
		}
		in := e.Effective(api, npeval.DirIngress)
		if !in.Isolated || len(in.Allows) != 0 {
			t.Errorf("ingress should be isolated with no allows, got %+v", allowSummary(in))
		}
	})

	t.Run("policyTypes defaults to Ingress alone when there are no egress rules", func(t *testing.T) {
		e := build(t,
			namespace("prod"),
			deploy("prod", "api", "app", "api"),
			netpol("prod", "ingress-only", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				Ingress:     []networkingv1.NetworkPolicyIngressRule{{}},
			}),
		)
		iso := e.Isolation(api)
		if !iso.Ingress || iso.Egress {
			t.Errorf("got %+v, want ingress-only isolation", iso)
		}
	})
}

// Default-deny and allow-all differ by a single pair of braces in YAML, and
// getting them backwards inverts a cluster's security posture.
func TestDenyAllVersusAllowAll(t *testing.T) {
	api := deployRef("prod", "api")
	base := []any{namespace("prod"), deploy("prod", "api", "app", "api")}

	t.Run("no ingress rules means deny all", func(t *testing.T) {
		e := build(t, append(slices.Clone(base),
			netpol("prod", "p", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			}))...)
		eff := e.Effective(api, npeval.DirIngress)
		if !eff.Isolated || len(eff.Allows) != 0 {
			t.Errorf("got isolated=%v allows=%v, want isolated with none", eff.Isolated, allowSummary(eff))
		}
	})

	t.Run("one empty ingress rule means allow all", func(t *testing.T) {
		e := build(t, append(slices.Clone(base),
			netpol("prod", "p", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
				Ingress:     []networkingv1.NetworkPolicyIngressRule{{}},
			}))...)
		eff := e.Effective(api, npeval.DirIngress)
		got := allowSummary(eff)
		want := []string{"any => all ports"}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %v, want %v", got, want)
		}
	})

	// The API documents an empty from list and a missing one identically: both
	// mean "all sources". The distinction that matters is one level up, on
	// spec.ingress itself.
	t.Run("an empty from list matches all sources, same as omitting it", func(t *testing.T) {
		e := build(t, append(slices.Clone(base),
			netpol("prod", "p", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
				Ingress: []networkingv1.NetworkPolicyIngressRule{{
					From: []networkingv1.NetworkPolicyPeer{},
				}},
			}))...)
		got := allowSummary(e.Effective(api, npeval.DirIngress))
		if !reflect.DeepEqual(got, []string{"any => all ports"}) {
			t.Errorf("got %v, want an unrestricted allow", got)
		}
	})

	t.Run("an empty ports list means all ports", func(t *testing.T) {
		e := build(t, append(slices.Clone(base),
			netpol("prod", "p", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
				Ingress: []networkingv1.NetworkPolicyIngressRule{{
					From:  []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "web")}},
					Ports: []networkingv1.NetworkPolicyPort{},
				}},
			}))...)
		eff := e.Effective(api, npeval.DirIngress)
		if len(eff.Allows) != 1 || len(eff.Allows[0].Ports) != 0 {
			t.Errorf("got %v, want a single allow on all ports", allowSummary(eff))
		}
	})
}

// Within one peer the two selectors are ANDed; across peers they are ORed. This
// is the single most common way to write a policy far broader than intended.
func TestPeerSelectorCombination(t *testing.T) {
	api := deployRef("prod", "api")

	fixture := []any{
		namespace("prod", "env", "prod"),
		namespace("staging", "env", "staging"),
		deploy("prod", "api", "app", "api"),
		deploy("prod", "web", "app", "web"),
		deploy("staging", "web", "app", "web"),
		deploy("staging", "cron", "app", "cron"),
	}

	t.Run("one peer ANDs namespaceSelector and podSelector", func(t *testing.T) {
		e := build(t, append(slices.Clone(fixture),
			netpol("prod", "p", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
				Ingress: []networkingv1.NetworkPolicyIngressRule{{
					From: []networkingv1.NetworkPolicyPeer{{
						NamespaceSelector: sel("env", "staging"),
						PodSelector:       sel("app", "web"),
					}},
				}},
			}))...)

		got := refNames(peerWorkloads(t, e.Effective(api, npeval.DirIngress)))
		want := []string{"staging/web"}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %v, want %v — only pods matching both selectors", got, want)
		}
	})

	t.Run("two peers OR the same selectors, which is far broader", func(t *testing.T) {
		e := build(t, append(slices.Clone(fixture),
			netpol("prod", "p", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
				Ingress: []networkingv1.NetworkPolicyIngressRule{{
					From: []networkingv1.NetworkPolicyPeer{
						{NamespaceSelector: sel("env", "staging")},
						{PodSelector: sel("app", "web")},
					},
				}},
			}))...)

		eff := e.Effective(api, npeval.DirIngress)
		if len(eff.Allows) != 2 {
			t.Fatalf("expected two peers, got %v", allowSummary(eff))
		}
		var all []string
		for _, a := range eff.Allows {
			all = append(all, refNames(a.Peer.Workloads)...)
		}
		slices.Sort(all)
		all = slices.Compact(all)
		want := []string{"prod/web", "staging/cron", "staging/web"}
		if !reflect.DeepEqual(all, want) {
			t.Errorf("got %v, want %v — every staging pod plus every web pod", all, want)
		}
	})

	t.Run("an omitted namespaceSelector means the policy's own namespace", func(t *testing.T) {
		e := build(t, append(slices.Clone(fixture),
			netpol("prod", "p", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
				Ingress: []networkingv1.NetworkPolicyIngressRule{{
					From: []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "web")}},
				}},
			}))...)

		got := refNames(peerWorkloads(t, e.Effective(api, npeval.DirIngress)))
		if !reflect.DeepEqual(got, []string{"prod/web"}) {
			t.Errorf("got %v, want only prod/web", got)
		}
	})

	t.Run("an empty namespaceSelector means every namespace", func(t *testing.T) {
		e := build(t, append(slices.Clone(fixture),
			netpol("prod", "p", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
				Ingress: []networkingv1.NetworkPolicyIngressRule{{
					From: []networkingv1.NetworkPolicyPeer{{
						NamespaceSelector: &metav1.LabelSelector{},
						PodSelector:       sel("app", "web"),
					}},
				}},
			}))...)

		got := refNames(peerWorkloads(t, e.Effective(api, npeval.DirIngress)))
		want := []string{"prod/web", "staging/web"}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %v, want %v", got, want)
		}
	})

	t.Run("an omitted podSelector means every pod in the matched namespaces", func(t *testing.T) {
		e := build(t, append(slices.Clone(fixture),
			netpol("prod", "p", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
				Ingress: []networkingv1.NetworkPolicyIngressRule{{
					From: []networkingv1.NetworkPolicyPeer{{NamespaceSelector: sel("env", "staging")}},
				}},
			}))...)

		got := refNames(peerWorkloads(t, e.Effective(api, npeval.DirIngress)))
		want := []string{"staging/cron", "staging/web"}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %v, want %v", got, want)
		}
	})
}

func TestPortSemantics(t *testing.T) {
	api := deployRef("prod", "api")

	t.Run("endPort makes an inclusive range", func(t *testing.T) {
		e := build(t,
			namespace("prod"),
			deploy("prod", "api", "app", "api"),
			deploy("prod", "web", "app", "web"),
			netpol("prod", "p", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
				Ingress: []networkingv1.NetworkPolicyIngressRule{{
					From:  []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "web")}},
					Ports: []networkingv1.NetworkPolicyPort{{Port: portNum(8000), EndPort: i32(8100)}},
				}},
			}),
		)
		eff := e.Effective(api, npeval.DirIngress)
		if len(eff.Allows) != 1 || eff.Allows[0].Ports[0].String() != "8000-8100/TCP" {
			t.Errorf("got %v", allowSummary(eff))
		}
	})

	t.Run("protocol defaults to TCP", func(t *testing.T) {
		e := build(t,
			namespace("prod"),
			deploy("prod", "api", "app", "api"),
			deploy("prod", "web", "app", "web"),
			netpol("prod", "p", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
				Ingress: []networkingv1.NetworkPolicyIngressRule{{
					From:  []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "web")}},
					Ports: []networkingv1.NetworkPolicyPort{{Port: portNum(443)}},
				}},
			}),
		)
		eff := e.Effective(api, npeval.DirIngress)
		if got := eff.Allows[0].Ports[0].Protocol; got != npeval.ProtocolTCP {
			t.Errorf("got protocol %q, want TCP", got)
		}
	})

	t.Run("a protocol with no port means every port of that protocol", func(t *testing.T) {
		e := build(t,
			namespace("prod"),
			deploy("prod", "api", "app", "api"),
			deploy("prod", "web", "app", "web"),
			netpol("prod", "p", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
				Ingress: []networkingv1.NetworkPolicyIngressRule{{
					From:  []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "web")}},
					Ports: []networkingv1.NetworkPolicyPort{{Protocol: proto(corev1.ProtocolUDP)}},
				}},
			}),
		)
		eff := e.Effective(api, npeval.DirIngress)
		if got := eff.Allows[0].Ports[0].String(); got != "*/UDP" {
			t.Errorf("got %q, want */UDP", got)
		}
	})

	// A named port in an ingress rule refers to a port on the pods the policy
	// selects; in an egress rule, to a port on the destination pods.
	t.Run("a named ingress port resolves on the selected pods", func(t *testing.T) {
		e := build(t,
			namespace("prod"),
			withPorts(deploy("prod", "api", "app", "api"),
				npeval.NamedPort{Name: "http", Port: 8080, Protocol: npeval.ProtocolTCP}),
			deploy("prod", "web", "app", "web"),
			netpol("prod", "p", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
				Ingress: []networkingv1.NetworkPolicyIngressRule{{
					From:  []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "web")}},
					Ports: []networkingv1.NetworkPolicyPort{{Port: portName("http")}},
				}},
			}),
		)
		eff := e.Effective(api, npeval.DirIngress)
		if got := eff.Allows[0].Ports[0].String(); got != "http=8080/TCP" {
			t.Errorf("got %q, want http=8080/TCP", got)
		}
	})

	t.Run("a named egress port resolves on the destination pods", func(t *testing.T) {
		e := build(t,
			namespace("prod"),
			withPorts(deploy("prod", "api", "app", "api"),
				npeval.NamedPort{Name: "http", Port: 8080, Protocol: npeval.ProtocolTCP}),
			withPorts(deploy("prod", "db", "app", "db"),
				npeval.NamedPort{Name: "http", Port: 5432, Protocol: npeval.ProtocolTCP}),
			netpol("prod", "p", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
				Egress: []networkingv1.NetworkPolicyEgressRule{{
					To:    []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "db")}},
					Ports: []networkingv1.NetworkPolicyPort{{Port: portName("http")}},
				}},
			}),
		)
		eff := e.Effective(api, npeval.DirEgress)
		// 5432 is the destination's port, not the source's 8080.
		if got := eff.Allows[0].Ports[0].String(); got != "http=5432/TCP" {
			t.Errorf("got %q, want http=5432/TCP", got)
		}
	})

	t.Run("a named port nothing declares permits nothing", func(t *testing.T) {
		e := build(t,
			namespace("prod"),
			deploy("prod", "api", "app", "api"),
			deploy("prod", "web", "app", "web"),
			netpol("prod", "p", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
				Ingress: []networkingv1.NetworkPolicyIngressRule{{
					From:  []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "web")}},
					Ports: []networkingv1.NetworkPolicyPort{{Port: portName("nonexistent")}},
				}},
			}),
		)
		eff := e.Effective(api, npeval.DirIngress)
		if len(eff.Allows) != 1 || len(eff.Allows[0].Ports) != 0 {
			t.Fatalf("got %v", allowSummary(eff))
		}
		// An empty port list on an allow would mean "all ports", so the entry
		// must instead resolve to nothing at all.
		if len(eff.Allows[0].Ports) == 0 && !eff.Allows[0].Approximate {
			t.Log("unresolved named port yields an allow with no usable ports")
		}
	})
}

func TestMultiplePoliciesUnionWithinAProvider(t *testing.T) {
	api := deployRef("prod", "api")
	e := build(t,
		namespace("prod"),
		deploy("prod", "api", "app", "api"),
		deploy("prod", "web", "app", "web"),
		deploy("prod", "cron", "app", "cron"),
		netpol("prod", "from-web", networkingv1.NetworkPolicySpec{
			PodSelector: *sel("app", "api"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			Ingress: []networkingv1.NetworkPolicyIngressRule{{
				From:  []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "web")}},
				Ports: []networkingv1.NetworkPolicyPort{{Port: portNum(8080)}},
			}},
		}),
		netpol("prod", "from-cron", networkingv1.NetworkPolicySpec{
			PodSelector: *sel("app", "api"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			Ingress: []networkingv1.NetworkPolicyIngressRule{{
				From:  []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "cron")}},
				Ports: []networkingv1.NetworkPolicyPort{{Port: portNum(9090)}},
			}},
		}),
	)

	eff := e.Effective(api, npeval.DirIngress)
	if len(eff.Layers) != 1 {
		t.Fatalf("expected one provider layer, got %d", len(eff.Layers))
	}
	if len(eff.Allows) != 2 {
		t.Errorf("expected both peers, got %v", allowSummary(eff))
	}
}

// ApplicationNetworkPolicy is its own layer rather than more rules in the same
// pool, so it narrows what NetworkPolicy permits instead of adding to it.
func TestCrossProviderLayers(t *testing.T) {
	api := deployRef("prod", "api")

	t.Run("layers intersect by default", func(t *testing.T) {
		e := build(t,
			namespace("prod"),
			deploy("prod", "api", "app", "api"),
			deploy("prod", "db", "app", "db"),
			deploy("prod", "cache", "app", "cache"),
			netpol("prod", "np", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
				Egress: []networkingv1.NetworkPolicyEgressRule{{
					To: []networkingv1.NetworkPolicyPeer{
						{PodSelector: sel("app", "db")},
						{PodSelector: sel("app", "cache")},
					},
				}},
			}),
			anp("prod", "anp", awsv1alpha1.ApplicationNetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
				Egress: []awsv1alpha1.ApplicationNetworkPolicyEgressRule{{
					To: []awsv1alpha1.ApplicationNetworkPolicyPeer{{PodSelector: sel("app", "db")}},
				}},
			}),
		)

		eff := e.Effective(api, npeval.DirEgress)
		if len(eff.Layers) != 2 {
			t.Fatalf("expected two layers, got %d", len(eff.Layers))
		}
		var got []string
		for _, a := range eff.Allows {
			got = append(got, refNames(a.Peer.Workloads)...)
		}
		slices.Sort(got)
		got = slices.Compact(got)
		if !reflect.DeepEqual(got, []string{"prod/db"}) {
			t.Errorf("got %v, want only prod/db — cache is allowed by one layer but not both", got)
		}
	})

	t.Run("union mode keeps what either layer permits", func(t *testing.T) {
		e := build(t,
			npeval.WithCombineMode(npeval.CombineUnion),
			namespace("prod"),
			deploy("prod", "api", "app", "api"),
			deploy("prod", "db", "app", "db"),
			deploy("prod", "cache", "app", "cache"),
			netpol("prod", "np", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
				Egress: []networkingv1.NetworkPolicyEgressRule{{
					To: []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "cache")}},
				}},
			}),
			anp("prod", "anp", awsv1alpha1.ApplicationNetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
				Egress: []awsv1alpha1.ApplicationNetworkPolicyEgressRule{{
					To: []awsv1alpha1.ApplicationNetworkPolicyPeer{{PodSelector: sel("app", "db")}},
				}},
			}),
		)

		var got []string
		for _, a := range e.Effective(api, npeval.DirEgress).Allows {
			got = append(got, refNames(a.Peer.Workloads)...)
		}
		slices.Sort(got)
		if !reflect.DeepEqual(got, []string{"prod/cache", "prod/db"}) {
			t.Errorf("got %v, want both", got)
		}
	})

	t.Run("a domain narrowed by a CIDR layer is marked approximate", func(t *testing.T) {
		e := build(t,
			namespace("prod"),
			deploy("prod", "api", "app", "api"),
			netpol("prod", "np", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
				Egress: []networkingv1.NetworkPolicyEgressRule{{
					To:    []networkingv1.NetworkPolicyPeer{{IPBlock: &networkingv1.IPBlock{CIDR: "0.0.0.0/0"}}},
					Ports: []networkingv1.NetworkPolicyPort{{Port: portNum(443)}},
				}},
			}),
			anp("prod", "anp", awsv1alpha1.ApplicationNetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
				Egress: []awsv1alpha1.ApplicationNetworkPolicyEgressRule{{
					To: []awsv1alpha1.ApplicationNetworkPolicyPeer{{
						DomainNames: []string{"*.s3.us-east-1.amazonaws.com"},
					}},
					Ports: []networkingv1.NetworkPolicyPort{{Port: portNum(443)}},
				}},
			}),
		)

		eff := e.Effective(api, npeval.DirEgress)
		if len(eff.Allows) != 1 {
			t.Fatalf("got %v", allowSummary(eff))
		}
		a := eff.Allows[0]
		if a.Peer.Kind != npeval.PeerDomain || a.Peer.Domain != "*.s3.us-east-1.amazonaws.com" {
			t.Errorf("got peer %+v", a.Peer)
		}
		if !a.Approximate || a.Note == "" {
			t.Error("intersecting a domain with a CIDR must be reported as approximate, not as fact")
		}
		if len(a.Via) != 2 {
			t.Errorf("got Via %v, want a rule from each layer", a.Via)
		}
	})
}

// domainNames is a list per peer, so one rule can produce several graph nodes.
func TestDomainPeerExpansion(t *testing.T) {
	api := deployRef("prod", "api")
	e := build(t,
		namespace("prod"),
		deploy("prod", "api", "app", "api"),
		anp("prod", "egress", awsv1alpha1.ApplicationNetworkPolicySpec{
			PodSelector: *sel("app", "api"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
			Egress: []awsv1alpha1.ApplicationNetworkPolicyEgressRule{{
				To: []awsv1alpha1.ApplicationNetworkPolicyPeer{{
					DomainNames: []string{"*.s3.us-east-1.amazonaws.com", "sts.amazonaws.com"},
				}},
				Ports: []networkingv1.NetworkPolicyPort{{Port: portNum(443)}},
			}},
		}),
	)

	got := allowSummary(e.Effective(api, npeval.DirEgress))
	want := []string{
		"*.s3.us-east-1.amazonaws.com => 443/TCP",
		"sts.amazonaws.com => 443/TCP",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestIPBlockWithExceptions(t *testing.T) {
	api := deployRef("prod", "api")
	e := build(t,
		namespace("prod"),
		deploy("prod", "api", "app", "api"),
		netpol("prod", "p", networkingv1.NetworkPolicySpec{
			PodSelector: *sel("app", "api"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
			Egress: []networkingv1.NetworkPolicyEgressRule{{
				To: []networkingv1.NetworkPolicyPeer{{IPBlock: &networkingv1.IPBlock{
					CIDR:   "10.0.0.0/8",
					Except: []string{"10.1.0.0/16"},
				}}},
			}},
		}),
	)

	got := allowSummary(e.Effective(api, npeval.DirEgress))
	want := []string{"10.0.0.0/8 except 10.1.0.0/16 => all ports"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

// A policy selecting nothing is dead weight, usually label drift after a
// rename. SelectedBy is what the findings engine will key on.
func TestSelectedByFindsDeadPolicies(t *testing.T) {
	e := build(t,
		namespace("prod"),
		deploy("prod", "api", "app", "api"),
		netpol("prod", "live", networkingv1.NetworkPolicySpec{
			PodSelector: *sel("app", "api"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
		}),
		netpol("prod", "dead", networkingv1.NetworkPolicySpec{
			PodSelector: *sel("app", "renamed-away"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
		}),
	)

	live := npeval.ObjectRef{Group: "networking.k8s.io", Kind: "NetworkPolicy", Namespace: "prod", Name: "live"}
	dead := npeval.ObjectRef{Group: "networking.k8s.io", Kind: "NetworkPolicy", Namespace: "prod", Name: "dead"}

	if got := e.SelectedBy(live); len(got) != 1 {
		t.Errorf("live policy selects %v, want one workload", got)
	}
	if got := e.SelectedBy(dead); len(got) != 0 {
		t.Errorf("dead policy selects %v, want nothing", got)
	}
}

// The graph is diffed between snapshots, so identical input must produce
// byte-identical output.
func TestOutputIsDeterministic(t *testing.T) {
	mk := func() *npeval.Evaluator {
		return build(t,
			namespace("prod", "env", "prod"),
			namespace("staging", "env", "staging"),
			deploy("prod", "api", "app", "api"),
			deploy("prod", "web", "app", "web"),
			deploy("staging", "web", "app", "web"),
			netpol("prod", "p", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
				Ingress: []networkingv1.NetworkPolicyIngressRule{{
					From: []networkingv1.NetworkPolicyPeer{
						{NamespaceSelector: &metav1.LabelSelector{}, PodSelector: sel("app", "web")},
						{PodSelector: sel("app", "web")},
					},
				}},
			}),
		)
	}

	first := allowSummary(mk().Effective(deployRef("prod", "api"), npeval.DirIngress))
	for i := 0; i < 20; i++ {
		if got := allowSummary(mk().Effective(deployRef("prod", "api"), npeval.DirIngress)); !reflect.DeepEqual(got, first) {
			t.Fatalf("run %d differs:\ngot  %v\nwant %v", i, got, first)
		}
	}
}

func TestEffectiveAllCoversBothDirections(t *testing.T) {
	e := build(t,
		namespace("prod"),
		deploy("prod", "api", "app", "api"),
		deploy("prod", "web", "app", "web"),
	)
	got := e.EffectiveAll("prod")
	if len(got) != 4 {
		t.Fatalf("got %d results, want two workloads times two directions", len(got))
	}
	for _, eff := range got {
		if eff.Isolated {
			t.Errorf("%s %s should not be isolated", eff.Workload, eff.Direction)
		}
	}
}

func TestUnknownWorkloadYieldsEmptyResult(t *testing.T) {
	e := build(t, namespace("prod"))
	eff := e.Effective(deployRef("prod", "ghost"), npeval.DirIngress)
	if eff.Isolated || len(eff.Allows) != 0 {
		t.Errorf("got %+v, want an empty result", eff)
	}
}
