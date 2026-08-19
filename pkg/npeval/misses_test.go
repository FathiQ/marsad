package npeval_test

import (
	"encoding/json"
	"testing"

	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	awsv1alpha1 "github.com/FathiQ/marsad/pkg/apis/awsanp/v1alpha1"
	"github.com/FathiQ/marsad/pkg/npeval"
)

// expr builds a matchExpressions-only selector.
func expr(reqs ...metav1.LabelSelectorRequirement) *metav1.LabelSelector {
	return &metav1.LabelSelector{MatchExpressions: reqs}
}

func req(key string, op metav1.LabelSelectorOperator, values ...string) metav1.LabelSelectorRequirement {
	return metav1.LabelSelectorRequirement{Key: key, Operator: op, Values: values}
}

// denyAll is the shape every one of these policies takes: what it governs is
// irrelevant here, only which pods its podSelector reaches.
func denyAll(selector *metav1.LabelSelector) networkingv1.NetworkPolicySpec {
	return networkingv1.NetworkPolicySpec{
		PodSelector: *selector,
		PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
	}
}

func TestSelectorExplain(t *testing.T) {
	tests := []struct {
		name        string
		selector    *metav1.LabelSelector
		labels      map[string]string
		wantMissed  []string
		wantMatched int
	}{
		{
			name:        "equality misses on the value",
			selector:    sel("app", "web"),
			labels:      labelMap("app", "worker"),
			wantMissed:  []string{"app=web"},
			wantMatched: 0,
		},
		{
			name:        "equality misses because the key is absent",
			selector:    sel("app", "web"),
			labels:      labelMap("tier", "edge"),
			wantMissed:  []string{"app=web"},
			wantMatched: 0,
		},
		{
			name:        "one clause of two fails",
			selector:    sel("app", "web", "tier", "edge"),
			labels:      labelMap("app", "worker", "tier", "edge"),
			wantMissed:  []string{"app=web"},
			wantMatched: 1,
		},
		{
			name:        "everything matches",
			selector:    sel("app", "web"),
			labels:      labelMap("app", "web"),
			wantMissed:  nil,
			wantMatched: 1,
		},
		{
			name:        "the empty selector has no clauses and matches",
			selector:    sel(),
			labels:      labelMap("app", "worker"),
			wantMissed:  nil,
			wantMatched: 0,
		},

		// The four operators, each in the state that makes it fail.
		{
			name:        "In: value is outside the set",
			selector:    expr(req("app", metav1.LabelSelectorOpIn, "api", "db")),
			labels:      labelMap("app", "worker"),
			wantMissed:  []string{"app in (api, db)"},
			wantMatched: 0,
		},
		{
			name:        "In: value is inside the set",
			selector:    expr(req("app", metav1.LabelSelectorOpIn, "api", "db")),
			labels:      labelMap("app", "db"),
			wantMissed:  nil,
			wantMatched: 1,
		},
		{
			name:        "NotIn: value is in the excluded set",
			selector:    expr(req("tier", metav1.LabelSelectorOpNotIn, "edge", "dmz")),
			labels:      labelMap("tier", "edge"),
			wantMissed:  []string{"tier not in (dmz, edge)"},
			wantMatched: 0,
		},
		{
			name:     "NotIn: a missing key satisfies it",
			selector: expr(req("tier", metav1.LabelSelectorOpNotIn, "edge")),
			// Kubernetes treats NotIn as satisfied when the key is absent, which
			// is a corner people get wrong by hand and the reason this delegates
			// to apimachinery rather than reimplementing the operators.
			labels:      labelMap("app", "worker"),
			wantMissed:  nil,
			wantMatched: 1,
		},
		{
			name:        "Exists: the key is absent",
			selector:    expr(req("role", metav1.LabelSelectorOpExists)),
			labels:      labelMap("app", "worker"),
			wantMissed:  []string{"role exists"},
			wantMatched: 0,
		},
		{
			name:        "Exists: the key is present, whatever its value",
			selector:    expr(req("role", metav1.LabelSelectorOpExists)),
			labels:      labelMap("role", ""),
			wantMissed:  nil,
			wantMatched: 1,
		},
		{
			name:        "DoesNotExist: the key is present",
			selector:    expr(req("legacy", metav1.LabelSelectorOpDoesNotExist)),
			labels:      labelMap("legacy", "true"),
			wantMissed:  []string{"legacy does not exist"},
			wantMatched: 0,
		},
		{
			name:        "DoesNotExist: the key is absent",
			selector:    expr(req("legacy", metav1.LabelSelectorOpDoesNotExist)),
			labels:      labelMap("app", "worker"),
			wantMissed:  nil,
			wantMatched: 1,
		},
		{
			name: "mixed operators report only the clauses that fail",
			selector: &metav1.LabelSelector{
				MatchLabels: labelMap("app", "web"),
				MatchExpressions: []metav1.LabelSelectorRequirement{
					req("tier", metav1.LabelSelectorOpIn, "edge", "dmz"),
					req("legacy", metav1.LabelSelectorOpDoesNotExist),
				},
			},
			labels:      labelMap("app", "worker", "tier", "edge"),
			wantMissed:  []string{"app=web"},
			wantMatched: 2,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := npeval.MustSelector(tc.selector)
			missed, matched := s.Explain(tc.labels)

			got := make([]string, len(missed))
			for i, m := range missed {
				got[i] = m.Text
			}
			if len(got) != len(tc.wantMissed) {
				t.Fatalf("missed = %v, want %v", got, tc.wantMissed)
			}
			for i := range got {
				if got[i] != tc.wantMissed[i] {
					t.Errorf("missed[%d] = %q, want %q", i, got[i], tc.wantMissed[i])
				}
			}
			if matched != tc.wantMatched {
				t.Errorf("matched = %d, want %d", matched, tc.wantMatched)
			}

			// Explain must agree with Matches: a selector reporting no failed
			// clauses that nonetheless does not match would send someone hunting
			// for a discrepancy that is not in their cluster.
			if (len(missed) == 0) != s.Matches(tc.labels) {
				t.Errorf("Explain reported %d missed clauses but Matches = %v",
					len(missed), s.Matches(tc.labels))
			}
		})
	}
}

// TestSelectorExplainCarriesTheWorkloadsValue covers the half of the answer that
// is about the pod rather than the policy.
func TestSelectorExplainCarriesTheWorkloadsValue(t *testing.T) {
	s := npeval.MustSelector(sel("app", "web"))

	missed, _ := s.Explain(labelMap("app", "worker"))
	if len(missed) != 1 {
		t.Fatalf("expected one missed clause, got %d", len(missed))
	}
	if missed[0].Key != "app" {
		t.Errorf("Key = %q, want app", missed[0].Key)
	}
	if missed[0].Value != "worker" || !missed[0].Present {
		t.Errorf("Value = %q present = %v, want worker/true", missed[0].Value, missed[0].Present)
	}

	// An absent label and an empty one are different situations: one is a typo
	// in the policy, the other is a typo in the workload.
	missed, _ = s.Explain(labelMap("tier", "edge"))
	if len(missed) != 1 {
		t.Fatalf("expected one missed clause, got %d", len(missed))
	}
	if missed[0].Value != "" || missed[0].Present {
		t.Errorf("Value = %q present = %v, want \"\"/false", missed[0].Value, missed[0].Present)
	}

	missed, _ = s.Explain(labelMap("app", ""))
	if len(missed) != 1 || !missed[0].Present {
		t.Fatalf("an empty label value must report as present, got %+v", missed)
	}
}

func TestClosestMisses(t *testing.T) {
	e := build(t,
		namespace("prod"),
		deploy("prod", "worker", "app", "worker", "tier", "edge"),
		deploy("prod", "web", "app", "web", "tier", "edge"),

		// One clause short, and it satisfies the other: the nearest miss there
		// is, and the one somebody almost certainly meant to extend.
		netpol("prod", "allow-web-edge", denyAll(sel("app", "web", "tier", "edge"))),
		// One clause short, sharing nothing else.
		netpol("prod", "allow-web", denyAll(sel("app", "web"))),
		// Also one clause short and sharing nothing, so it ties with allow-web
		// and the name breaks it — deterministically, which is the point.
		netpol("prod", "allow-api-or-db", denyAll(
			expr(req("app", metav1.LabelSelectorOpIn, "api", "db")))),
		// Two clauses short: furthest away.
		netpol("prod", "allow-db-internal", denyAll(sel("app", "db", "tier", "internal"))),
		// Selects the worker, so it is not a miss at all.
		netpol("prod", "deny-edge", denyAll(sel("tier", "edge"))),
		// A different namespace: a podSelector cannot reach out of its own.
		namespace("other"),
		netpol("other", "elsewhere", denyAll(sel("app", "worker"))),
	)

	misses := e.ClosestMisses(deployRef("prod", "worker"))

	var names []string
	for _, m := range misses {
		names = append(names, m.Policy.Name)
	}
	want := []string{"allow-web-edge", "allow-api-or-db", "allow-web", "allow-db-internal"}
	if len(names) != len(want) {
		t.Fatalf("misses = %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Errorf("misses[%d] = %q, want %q (full order %v)", i, names[i], want[i], names)
		}
	}

	// The closest one names the clause and what the workload has instead —
	// which is the half of the answer that says whether to fix the label or the
	// policy.
	first := misses[0]
	if len(first.Missed) != 1 || first.Missed[0].Text != "app=web" {
		t.Errorf("allow-web-edge should miss on app=web alone, got %+v", first.Missed)
	}
	if first.Missed[0].Value != "worker" || !first.Missed[0].Present {
		t.Errorf("allow-web-edge should report the workload's app=worker, got %+v", first.Missed[0])
	}
	if first.Matched != 1 {
		t.Errorf("allow-web-edge matched = %d, want 1 (tier=edge)", first.Matched)
	}
	if first.Selector != "app=web,tier=edge" {
		t.Errorf("Selector = %q, want app=web,tier=edge", first.Selector)
	}

	// The two-clause failure ranks last and says so.
	if last := misses[len(misses)-1]; len(last.Missed) != 2 {
		t.Errorf("allow-db-internal should miss on two clauses, got %+v", last.Missed)
	}
}

// TestClosestMissesExcludesSelectingPolicies keeps the two lists disjoint: a
// policy is either applied or a near miss, and showing it in both would make
// the empty state contradict the list above it.
func TestClosestMissesExcludesSelectingPolicies(t *testing.T) {
	e := build(t,
		namespace("prod"),
		deploy("prod", "api", "app", "api"),
		netpol("prod", "selects-it", denyAll(sel("app", "api"))),
		netpol("prod", "misses-it", denyAll(sel("app", "web"))),
		// The empty selector selects everything, so it is never a miss.
		netpol("prod", "selects-everything", denyAll(sel())),
	)

	misses := e.ClosestMisses(deployRef("prod", "api"))
	if len(misses) != 1 || misses[0].Policy.Name != "misses-it" {
		var names []string
		for _, m := range misses {
			names = append(names, m.Policy.Name)
		}
		t.Fatalf("misses = %v, want [misses-it]", names)
	}
}

func TestClosestMissesOnAnUnknownWorkload(t *testing.T) {
	e := build(t, namespace("prod"), deploy("prod", "api", "app", "api"))

	if got := e.ClosestMisses(deployRef("prod", "ghost")); got != nil {
		t.Errorf("ClosestMisses on an unknown workload = %v, want nil", got)
	}
}

// TestClosestMissesIncludesEveryProvider: an ApplicationNetworkPolicy that does
// not select the workload is as much a near miss as a NetworkPolicy, and the
// provider travels with it so the UI can badge which kind it is.
func TestClosestMissesIncludesEveryProvider(t *testing.T) {
	e := build(t,
		namespace("prod"),
		deploy("prod", "worker", "app", "worker"),
		anp("prod", "domain-egress", awsv1alpha1.ApplicationNetworkPolicySpec{
			PodSelector: *sel("app", "db"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
		}),
	)

	misses := e.ClosestMisses(deployRef("prod", "worker"))
	if len(misses) != 1 {
		t.Fatalf("expected one miss, got %d", len(misses))
	}
	if misses[0].Provider != "aws-anp" {
		t.Errorf("Provider = %q, want aws-anp", misses[0].Provider)
	}
	if len(misses[0].Missed) != 1 || misses[0].Missed[0].Text != "app=db" {
		t.Errorf("missed = %+v, want app=db", misses[0].Missed)
	}
}

// TestPolicyTypesRoundTrip: the mask travels as names, so a client reading the
// closest-misses list can badge the directions without knowing the bit layout.
func TestPolicyTypesRoundTrip(t *testing.T) {
	for _, tc := range []struct {
		types npeval.PolicyTypes
		json  string
	}{
		{npeval.TypeIngress, `"Ingress"`},
		{npeval.TypeEgress, `"Egress"`},
		{npeval.TypeIngress | npeval.TypeEgress, `"Ingress,Egress"`},
		{0, `""`},
	} {
		b, err := json.Marshal(tc.types)
		if err != nil {
			t.Fatalf("marshal %v: %v", tc.types, err)
		}
		if string(b) != tc.json {
			t.Errorf("marshal %v = %s, want %s", tc.types, b, tc.json)
		}

		var back npeval.PolicyTypes
		if err := json.Unmarshal(b, &back); err != nil {
			t.Fatalf("unmarshal %s: %v", b, err)
		}
		if back != tc.types {
			t.Errorf("round trip of %v gave %v", tc.types, back)
		}
	}

	var bad npeval.PolicyTypes
	if err := json.Unmarshal([]byte(`"Sideways"`), &bad); err == nil {
		t.Error("unmarshalling an unknown policy type succeeded, want an error")
	}
}
