package npeval_test

import (
	"encoding/json"
	"net/netip"
	"strings"
	"testing"

	networkingv1 "k8s.io/api/networking/v1"

	awsv1alpha1 "github.com/FathiQ/marsad/pkg/apis/awsanp/v1alpha1"
	"github.com/FathiQ/marsad/pkg/npeval"
)

func workloadEP(ns, name string) npeval.Endpoint {
	r := deployRef(ns, name)
	return npeval.Endpoint{Workload: &r}
}

func cidrEP(t *testing.T, s string) npeval.Endpoint {
	t.Helper()
	p, err := netip.ParsePrefix(s)
	if err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return npeval.Endpoint{CIDR: &p}
}

// A connection needs the source's egress and the destination's ingress to both
// permit it. Checking only one side is the usual way hand-reading goes wrong,
// so both halves are always reported.
func TestSimulateNeedsBothDirections(t *testing.T) {
	base := []any{
		namespace("prod"),
		deploy("prod", "api", "app", "api"),
		deploy("prod", "db", "app", "db"),
	}

	t.Run("open cluster allows everything", func(t *testing.T) {
		e := build(t, base...)
		v, err := e.Simulate(npeval.Query{
			From: workloadEP("prod", "api"), To: workloadEP("prod", "db"),
			Protocol: npeval.ProtocolTCP, Port: 5432,
		})
		if err != nil {
			t.Fatal(err)
		}
		if !v.Allowed {
			t.Errorf("got %s", v.Summary)
		}
		if v.Egress.Reason != npeval.ReasonNotIsolated || v.Ingress.Reason != npeval.ReasonNotIsolated {
			t.Errorf("both halves should report not-isolated, got %+v / %+v", v.Egress, v.Ingress)
		}
	})

	t.Run("egress allowed but ingress denied is denied", func(t *testing.T) {
		e := build(t, append(append([]any{}, base...),
			netpol("prod", "db-deny-ingress", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "db"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			}))...)

		v, err := e.Simulate(npeval.Query{
			From: workloadEP("prod", "api"), To: workloadEP("prod", "db"),
			Protocol: npeval.ProtocolTCP, Port: 5432,
		})
		if err != nil {
			t.Fatal(err)
		}
		if v.Allowed {
			t.Fatalf("got %s, want denied", v.Summary)
		}
		if v.Egress.Result != npeval.ResultAllowed {
			t.Errorf("egress should be allowed, got %v", v.Egress.Result)
		}
		if v.Ingress.Result != npeval.ResultDenied {
			t.Errorf("ingress should be denied, got %v", v.Ingress.Result)
		}
	})

	t.Run("ingress allowed but egress denied is denied", func(t *testing.T) {
		e := build(t, append(append([]any{}, base...),
			netpol("prod", "api-egress", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
				Egress: []networkingv1.NetworkPolicyEgressRule{{
					To: []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "cache")}},
				}},
			}))...)

		v, err := e.Simulate(npeval.Query{
			From: workloadEP("prod", "api"), To: workloadEP("prod", "db"),
			Protocol: npeval.ProtocolTCP, Port: 5432,
		})
		if err != nil {
			t.Fatal(err)
		}
		if v.Allowed || v.Egress.Result != npeval.ResultDenied {
			t.Errorf("got %s / egress %v, want denied", v.Summary, v.Egress.Result)
		}
		if v.Ingress.Result != npeval.ResultAllowed {
			t.Errorf("ingress should be allowed, got %v", v.Ingress.Result)
		}
	})

	t.Run("both sides allowing yields the rules that did it", func(t *testing.T) {
		e := build(t, append(append([]any{}, base...),
			netpol("prod", "api-egress", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
				Egress: []networkingv1.NetworkPolicyEgressRule{{
					To:    []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "db")}},
					Ports: []networkingv1.NetworkPolicyPort{{Port: portNum(5432)}},
				}},
			}),
			netpol("prod", "db-ingress", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "db"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
				Ingress: []networkingv1.NetworkPolicyIngressRule{{
					From:  []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "api")}},
					Ports: []networkingv1.NetworkPolicyPort{{Port: portNum(5432)}},
				}},
			}))...)

		v, err := e.Simulate(npeval.Query{
			From: workloadEP("prod", "api"), To: workloadEP("prod", "db"),
			Protocol: npeval.ProtocolTCP, Port: 5432,
		})
		if err != nil {
			t.Fatal(err)
		}
		if !v.Allowed {
			t.Fatalf("got %s", v.Summary)
		}
		// Traceability is the point of the panel: the verdict must name rules.
		if len(v.Egress.Via) == 0 || len(v.Ingress.Via) == 0 {
			t.Errorf("both halves should cite rules, got %v / %v", v.Egress.Via, v.Ingress.Via)
		}
		if !strings.Contains(string(v.Egress.Via[0]), "api-egress#egress[0]") {
			t.Errorf("got %v, want the egress rule cited", v.Egress.Via)
		}
	})

	t.Run("the wrong port is denied even when the peer matches", func(t *testing.T) {
		e := build(t, append(append([]any{}, base...),
			netpol("prod", "db-ingress", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "db"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
				Ingress: []networkingv1.NetworkPolicyIngressRule{{
					From:  []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "api")}},
					Ports: []networkingv1.NetworkPolicyPort{{Port: portNum(5432)}},
				}},
			}))...)

		v, err := e.Simulate(npeval.Query{
			From: workloadEP("prod", "api"), To: workloadEP("prod", "db"),
			Protocol: npeval.ProtocolTCP, Port: 6379,
		})
		if err != nil {
			t.Fatal(err)
		}
		if v.Allowed {
			t.Errorf("got %s, want denied on the wrong port", v.Summary)
		}
	})
}

func TestSimulateExternalEndpoints(t *testing.T) {
	base := []any{namespace("prod"), deploy("prod", "api", "app", "api")}

	t.Run("a CIDR destination matches an ipBlock rule", func(t *testing.T) {
		e := build(t, append(append([]any{}, base...),
			netpol("prod", "egress", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
				Egress: []networkingv1.NetworkPolicyEgressRule{{
					To:    []networkingv1.NetworkPolicyPeer{{IPBlock: &networkingv1.IPBlock{CIDR: "10.0.0.0/8"}}},
					Ports: []networkingv1.NetworkPolicyPort{{Port: portNum(443)}},
				}},
			}))...)

		v, err := e.Simulate(npeval.Query{
			From: workloadEP("prod", "api"), To: cidrEP(t, "10.1.2.3/32"),
			Protocol: npeval.ProtocolTCP, Port: 443,
		})
		if err != nil {
			t.Fatal(err)
		}
		if !v.Allowed {
			t.Errorf("got %s", v.Summary)
		}
		// The destination is not a workload, so there is no ingress half.
		if v.Ingress.Result != npeval.ResultNotApplicable {
			t.Errorf("got ingress %v, want N/A", v.Ingress.Result)
		}
	})

	t.Run("an excluded address is denied", func(t *testing.T) {
		e := build(t, append(append([]any{}, base...),
			netpol("prod", "egress", networkingv1.NetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
				Egress: []networkingv1.NetworkPolicyEgressRule{{
					To: []networkingv1.NetworkPolicyPeer{{IPBlock: &networkingv1.IPBlock{
						CIDR:   "10.0.0.0/8",
						Except: []string{"10.1.0.0/16"},
					}}},
				}},
			}))...)

		v, err := e.Simulate(npeval.Query{
			From: workloadEP("prod", "api"), To: cidrEP(t, "10.1.2.3/32"),
			Protocol: npeval.ProtocolTCP, Port: 443,
		})
		if err != nil {
			t.Fatal(err)
		}
		if v.Allowed {
			t.Errorf("got %s, want denied by the except block", v.Summary)
		}
	})

	t.Run("a domain destination matches a wildcard domain rule", func(t *testing.T) {
		e := build(t, append(append([]any{}, base...),
			anp("prod", "domains", awsv1alpha1.ApplicationNetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
				Egress: []awsv1alpha1.ApplicationNetworkPolicyEgressRule{{
					To: []awsv1alpha1.ApplicationNetworkPolicyPeer{{
						DomainNames: []string{"*.s3.me-south-1.amazonaws.com"},
					}},
					Ports: []networkingv1.NetworkPolicyPort{{Port: portNum(443)}},
				}},
			}))...)

		v, err := e.Simulate(npeval.Query{
			From:     workloadEP("prod", "api"),
			To:       npeval.Endpoint{Domain: "my-bucket.s3.me-south-1.amazonaws.com"},
			Protocol: npeval.ProtocolTCP, Port: 443,
		})
		if err != nil {
			t.Fatal(err)
		}
		if !v.Allowed {
			t.Errorf("got %s", v.Summary)
		}
	})

	// Answering this needs DNS, which Marsad deliberately does not observe.
	// Reporting DENIED would be a confident wrong answer.
	t.Run("an address against a domain rule is undecidable, not denied", func(t *testing.T) {
		e := build(t, append(append([]any{}, base...),
			anp("prod", "domains", awsv1alpha1.ApplicationNetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
				Egress: []awsv1alpha1.ApplicationNetworkPolicyEgressRule{{
					To: []awsv1alpha1.ApplicationNetworkPolicyPeer{{
						DomainNames: []string{"*.s3.me-south-1.amazonaws.com"},
					}},
					Ports: []networkingv1.NetworkPolicyPort{{Port: portNum(443)}},
				}},
			}))...)

		v, err := e.Simulate(npeval.Query{
			From: workloadEP("prod", "api"), To: cidrEP(t, "52.95.1.1/32"),
			Protocol: npeval.ProtocolTCP, Port: 443,
		})
		if err != nil {
			t.Fatal(err)
		}
		if !v.Undecidable {
			t.Fatalf("got %s, want undecidable", v.Summary)
		}
		if v.Egress.Reason != npeval.ReasonDomainResolution {
			t.Errorf("got reason %v", v.Egress.Reason)
		}
		if !strings.Contains(v.Egress.Explain, "DNS") {
			t.Errorf("the explanation should say why: %q", v.Egress.Explain)
		}
	})

	t.Run("a domain outside the allowed pattern is denied outright", func(t *testing.T) {
		e := build(t, append(append([]any{}, base...),
			anp("prod", "domains", awsv1alpha1.ApplicationNetworkPolicySpec{
				PodSelector: *sel("app", "api"),
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
				Egress: []awsv1alpha1.ApplicationNetworkPolicyEgressRule{{
					To: []awsv1alpha1.ApplicationNetworkPolicyPeer{{
						DomainNames: []string{"*.s3.me-south-1.amazonaws.com"},
					}},
				}},
			}))...)

		v, err := e.Simulate(npeval.Query{
			From:     workloadEP("prod", "api"),
			To:       npeval.Endpoint{Domain: "evil.example.com"},
			Protocol: npeval.ProtocolTCP, Port: 443,
		})
		if err != nil {
			t.Fatal(err)
		}
		if v.Allowed || v.Undecidable {
			t.Errorf("got %s, want a plain denial", v.Summary)
		}
	})
}

func TestSimulateReportsPerLayerResults(t *testing.T) {
	e := build(t,
		namespace("prod"),
		deploy("prod", "api", "app", "api"),
		deploy("prod", "db", "app", "db"),
		netpol("prod", "np", networkingv1.NetworkPolicySpec{
			PodSelector: *sel("app", "api"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
			Egress: []networkingv1.NetworkPolicyEgressRule{{
				To: []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "db")}},
			}},
		}),
		anp("prod", "anp", awsv1alpha1.ApplicationNetworkPolicySpec{
			PodSelector: *sel("app", "api"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
			Egress: []awsv1alpha1.ApplicationNetworkPolicyEgressRule{{
				To: []awsv1alpha1.ApplicationNetworkPolicyPeer{{PodSelector: sel("app", "cache")}},
			}},
		}),
	)

	v, err := e.Simulate(npeval.Query{
		From: workloadEP("prod", "api"), To: workloadEP("prod", "db"),
		Protocol: npeval.ProtocolTCP, Port: 5432,
	})
	if err != nil {
		t.Fatal(err)
	}
	if v.Allowed {
		t.Fatalf("got %s, want denied: only one layer permits it", v.Summary)
	}
	// Showing which layer refused is what makes the denial actionable.
	if got := v.Egress.ByLayer["k8s"]; got != npeval.ResultAllowed {
		t.Errorf("k8s layer = %v, want allowed", got)
	}
	if got := v.Egress.ByLayer["aws-anp"]; got != npeval.ResultDenied {
		t.Errorf("aws-anp layer = %v, want denied", got)
	}
}

// A layer that permits egress to the whole internet has not denied a domain,
// it has failed to resolve it. Reporting DENIED against such a layer points the
// blame at a policy that in fact permits everything, which is how somebody ends
// up deleting the wrong one.
func TestSimulateDoesNotBlameALayerThatCannotResolveTheDomain(t *testing.T) {
	e := build(t,
		namespace("prod"),
		deploy("prod", "api", "app", "api"),
		netpol("prod", "open-egress", networkingv1.NetworkPolicySpec{
			PodSelector: *sel("app", "api"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
			Egress: []networkingv1.NetworkPolicyEgressRule{{
				To: []networkingv1.NetworkPolicyPeer{{IPBlock: &networkingv1.IPBlock{CIDR: "0.0.0.0/0"}}},
			}},
		}),
		anp("prod", "anp", awsv1alpha1.ApplicationNetworkPolicySpec{
			PodSelector: *sel("app", "api"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
			Egress: []awsv1alpha1.ApplicationNetworkPolicyEgressRule{{
				To: []awsv1alpha1.ApplicationNetworkPolicyPeer{{DomainNames: []string{"sts.amazonaws.com"}}},
			}},
		}),
	)

	v, err := e.Simulate(npeval.Query{
		From: workloadEP("prod", "api"), To: npeval.Endpoint{Domain: "sts.amazonaws.com"},
		Protocol: npeval.ProtocolTCP, Port: 443,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := v.Egress.ByLayer["aws-anp"]; got != npeval.ResultAllowed {
		t.Errorf("aws-anp layer = %v, want allowed: it names the domain", got)
	}
	if got := v.Egress.ByLayer["k8s"]; got != npeval.ResultUndecidable {
		t.Errorf("k8s layer = %v, want undecidable: 0.0.0.0/0 may or may not cover it", got)
	}
}

// The ordinals are an implementation detail; a client reading "result": 2 and
// having to know that denied is declared third is a contract nobody can keep.
func TestVerdictEncodesResultsByName(t *testing.T) {
	e := build(t, namespace("prod"), deploy("prod", "api", "app", "api"),
		deploy("prod", "db", "app", "db"))
	v, err := e.Simulate(npeval.Query{
		From: workloadEP("prod", "api"), To: workloadEP("prod", "db"),
		Protocol: npeval.ProtocolTCP, Port: 5432,
	})
	if err != nil {
		t.Fatal(err)
	}

	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"result":"allowed"`) {
		t.Errorf("verdict JSON did not name its result: %s", raw)
	}
	if !strings.Contains(string(raw), `"reason":"not-isolated"`) {
		t.Errorf("verdict JSON did not name its reason: %s", raw)
	}

	var back npeval.Verdict
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("verdict does not survive a round trip: %v", err)
	}
	if back.Egress.Result != v.Egress.Result || back.Egress.Reason != v.Egress.Reason {
		t.Errorf("round trip = %v/%v, want %v/%v",
			back.Egress.Result, back.Egress.Reason, v.Egress.Result, v.Egress.Reason)
	}
}

func TestSimulateRejectsMalformedQueries(t *testing.T) {
	e := build(t, namespace("prod"), deploy("prod", "api", "app", "api"))
	p := netip.MustParsePrefix("10.0.0.0/8")

	tests := []struct {
		name string
		q    npeval.Query
	}{
		{"no from endpoint", npeval.Query{To: workloadEP("prod", "api"), Port: 443}},
		{"no to endpoint", npeval.Query{From: workloadEP("prod", "api"), Port: 443}},
		{
			"two fields on one endpoint",
			npeval.Query{
				From: npeval.Endpoint{CIDR: &p, Domain: "example.com"},
				To:   workloadEP("prod", "api"), Port: 443,
			},
		},
		{"port zero", npeval.Query{From: workloadEP("prod", "api"), To: workloadEP("prod", "api"), Port: 0}},
		{"port out of range", npeval.Query{From: workloadEP("prod", "api"), To: workloadEP("prod", "api"), Port: 70000}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := e.Simulate(tt.q); err == nil {
				t.Error("expected an error")
			}
		})
	}
}
