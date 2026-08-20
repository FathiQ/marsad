package graph_test

import (
	"slices"
	"testing"

	networkingv1 "k8s.io/api/networking/v1"

	"github.com/FathiQ/marsad/pkg/graph"
	"github.com/FathiQ/marsad/pkg/npeval"
)

// chain builds a --> b --> c --> d at workload level, so hop distance is
// something the test can state exactly.
func chain(t *testing.T) *graph.Graph {
	t.Helper()
	e := build(t,
		npeval.Namespace{Name: "prod"},
		deploy("prod", "a", "app", "a"),
		deploy("prod", "b", "app", "b"),
		deploy("prod", "c", "app", "c"),
		deploy("prod", "d", "app", "d"),
		allow(t, "prod", "b", "a"),
		allow(t, "prod", "c", "b"),
		allow(t, "prod", "d", "c"),
	)
	return graph.Build(e, graph.Options{Level: graph.LevelWorkload})
}

// allow builds "to accepts from from" on port 80.
func allow(t *testing.T, ns, to, from string) *networkingv1.NetworkPolicy {
	t.Helper()
	return netpol(ns, to+"-from-"+from, networkingv1.NetworkPolicySpec{
		PodSelector: *sel("app", to),
		PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
		Ingress: []networkingv1.NetworkPolicyIngressRule{{
			From:  []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", from)}},
			Ports: []networkingv1.NetworkPolicyPort{{Port: port(80)}},
		}},
	})
}

func nodeIDSet(g *graph.Graph) []string {
	out := make([]string, 0, len(g.Nodes))
	for _, n := range g.Nodes {
		out = append(out, n.ID)
	}
	slices.Sort(out)
	return out
}

func TestFocusKeepsTheNeighbourhoodAndCountsTheRest(t *testing.T) {
	full := chain(t)
	total := len(full.Nodes)

	e := build(t,
		npeval.Namespace{Name: "prod"},
		deploy("prod", "a", "app", "a"),
		deploy("prod", "b", "app", "b"),
		deploy("prod", "c", "app", "c"),
		deploy("prod", "d", "app", "d"),
		allow(t, "prod", "b", "a"),
		allow(t, "prod", "c", "b"),
		allow(t, "prod", "d", "c"),
	)
	g := graph.Build(e, graph.Options{
		Level:     graph.LevelWorkload,
		Focus:     "wl:prod/Deployment/a",
		FocusHops: 1,
	})

	if g.Focus == nil {
		t.Fatal("a focused build must report what it left out")
	}

	ids := nodeIDSet(g)
	// a and b are within one hop. c is two away and must not be drawn.
	if !slices.Contains(ids, "wl:prod/Deployment/a") || !slices.Contains(ids, "wl:prod/Deployment/b") {
		t.Errorf("focus dropped its own neighbourhood: %v", ids)
	}
	if slices.Contains(ids, "wl:prod/Deployment/c") {
		t.Errorf("c is two hops away and should not be drawn at hops=1: %v", ids)
	}

	// What is missing is stated, not silently absent.
	if g.Focus.Hidden != total-2 {
		t.Errorf("Hidden = %d, want %d", g.Focus.Hidden, total-2)
	}
	if g.Focus.TotalWorkloads != 4 {
		t.Errorf("TotalWorkloads = %d, want 4", g.Focus.TotalWorkloads)
	}
	if g.Focus.Workloads != 2 {
		t.Errorf("Workloads = %d, want 2", g.Focus.Workloads)
	}

	// And it is drawn as something, rather than as nothing.
	if !slices.Contains(ids, "cluster:hidden") {
		t.Errorf("expected a cluster node standing in for the rest: %v", ids)
	}
}

// TestFocusIsUndirected: "within two hops of payments" is a question about
// relationship, not traffic. A workload that only ever sends to the focus is as
// related to it as one that only receives.
func TestFocusIsUndirected(t *testing.T) {
	e := build(t,
		npeval.Namespace{Name: "prod"},
		deploy("prod", "a", "app", "a"),
		deploy("prod", "b", "app", "b"),
		allow(t, "prod", "b", "a"),
	)
	// b accepts from a, so the edge runs a -> b. Focusing on b must still find a.
	g := graph.Build(e, graph.Options{
		Level:     graph.LevelWorkload,
		Focus:     "wl:prod/Deployment/b",
		FocusHops: 1,
	})
	if !slices.Contains(nodeIDSet(g), "wl:prod/Deployment/a") {
		t.Errorf("focus followed edges one way only: %v", nodeIDSet(g))
	}
}

func TestFocusOnAnUnknownNodeChangesNothing(t *testing.T) {
	before := chain(t)

	e := build(t,
		npeval.Namespace{Name: "prod"},
		deploy("prod", "a", "app", "a"),
		deploy("prod", "b", "app", "b"),
		deploy("prod", "c", "app", "c"),
		deploy("prod", "d", "app", "d"),
		allow(t, "prod", "b", "a"),
		allow(t, "prod", "c", "b"),
		allow(t, "prod", "d", "c"),
	)
	// A stale focus from a graph that has moved on must not empty the screen,
	// which would read as a broken cluster rather than a stale request.
	g := graph.Build(e, graph.Options{Level: graph.LevelWorkload, Focus: "wl:prod/Deployment/ghost"})

	if len(g.Nodes) != len(before.Nodes) {
		t.Errorf("focusing on a node that is not drawn changed the graph: %d vs %d",
			len(g.Nodes), len(before.Nodes))
	}
	if g.Focus != nil {
		t.Error("no focus was applied, so none should be reported")
	}
}

// TestReachableFromOutsideFollowsTrafficDirection is the distinction that makes
// the filter worth having: a workload that can call the internet is not
// thereby reachable from it, and conflating the two would mark everything with
// egress as exposed.
func TestReachableFromOutsideFollowsTrafficDirection(t *testing.T) {
	e := build(t,
		npeval.Namespace{Name: "prod"},
		deploy("prod", "edge", "app", "edge"),
		deploy("prod", "worker", "app", "worker"),
		// edge accepts from the whole internet.
		netpol("prod", "edge-open", networkingv1.NetworkPolicySpec{
			PodSelector: *sel("app", "edge"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			Ingress: []networkingv1.NetworkPolicyIngressRule{{
				From: []networkingv1.NetworkPolicyPeer{
					{IPBlock: &networkingv1.IPBlock{CIDR: "0.0.0.0/0"}},
				},
				Ports: []networkingv1.NetworkPolicyPort{{Port: port(443)}},
			}},
		}),
		// worker only reaches out; nothing reaches it.
		netpol("prod", "worker-egress", networkingv1.NetworkPolicySpec{
			PodSelector: *sel("app", "worker"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
			Egress: []networkingv1.NetworkPolicyEgressRule{{
				To: []networkingv1.NetworkPolicyPeer{
					{IPBlock: &networkingv1.IPBlock{CIDR: "0.0.0.0/0"}},
				},
				Ports: []networkingv1.NetworkPolicyPort{{Port: port(443)}},
			}},
		}),
	)
	g := graph.Build(e, graph.Options{Level: graph.LevelWorkload})

	got := graph.ReachableFromOutside(g)
	if !slices.Contains(got, "wl:prod/Deployment/edge") {
		t.Errorf("edge accepts from 0.0.0.0/0 and should be reachable: %v", got)
	}
	if slices.Contains(got, "wl:prod/Deployment/worker") {
		t.Errorf("worker only calls out; being able to reach the internet is not "+
			"being reachable from it: %v", got)
	}
}

// TestPrivateRangesAreNotTheInternet: a rule naming 10.0.0.0/8 is somebody's
// VPC. Treating it as outside would mark half a cluster as externally
// reachable and make the finding worthless.
func TestPrivateRangesAreNotTheInternet(t *testing.T) {
	e := build(t,
		npeval.Namespace{Name: "prod"},
		deploy("prod", "api", "app", "api"),
		netpol("prod", "from-vpc", networkingv1.NetworkPolicySpec{
			PodSelector: *sel("app", "api"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			Ingress: []networkingv1.NetworkPolicyIngressRule{{
				From: []networkingv1.NetworkPolicyPeer{
					{IPBlock: &networkingv1.IPBlock{CIDR: "10.0.0.0/8"}},
				},
			}},
		}),
	)
	g := graph.Build(e, graph.Options{Level: graph.LevelWorkload})

	if got := graph.ReachableFromOutside(g); len(got) != 0 {
		t.Errorf("a private range is not the internet, got %v", got)
	}
}

func TestOversizedRefusesRatherThanDrawingAHairball(t *testing.T) {
	small := chain(t)
	if small.Oversized() {
		t.Error("a four-node graph is not oversize")
	}

	big := &graph.Graph{Nodes: make([]graph.Node, graph.MaxDrawableNodes+1)}
	if !big.Oversized() {
		t.Fatal("a graph past the limit should refuse to be drawn")
	}
	if big.Oversize == nil || big.Oversize.Nodes != graph.MaxDrawableNodes+1 {
		t.Errorf("Oversize = %+v, want the real count", big.Oversize)
	}
	// Refusing means saying so, not sending a hairball the client must discard.
	if len(big.Nodes) != 0 || len(big.Edges) != 0 {
		t.Error("an oversize graph should carry counts, not contents")
	}
}
