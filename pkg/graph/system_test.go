package graph_test

import (
	"slices"
	"testing"

	"github.com/FathiQ/marsad/pkg/graph"
	"github.com/FathiQ/marsad/pkg/npeval"
)

func systemCluster(t *testing.T) *npeval.Evaluator {
	t.Helper()
	return build(t,
		npeval.Namespace{Name: "prod"},
		npeval.Namespace{Name: "kube-system"},
		deploy("prod", "api", "app", "api"),
		deploy("kube-system", "coredns", "k8s-app", "kube-dns"),
		deploy("kube-system", "kube-proxy", "k8s-app", "kube-proxy"),
	)
}

// TestSystemNamespacesCollapse: on a fresh cluster these are frequently the
// only unprotected workloads there are, which is how the product's loudest
// signal ends up pointing at infrastructure nobody is going to write a policy
// for.
func TestSystemNamespacesCollapse(t *testing.T) {
	g := graph.Build(systemCluster(t), graph.Options{Level: graph.LevelWorkload})
	ids := nodeIDs(g)

	if !slices.Contains(ids, "wl:prod/Deployment/api") {
		t.Errorf("an ordinary workload should still be drawn: %v", ids)
	}
	for _, id := range ids {
		if id == "wl:kube-system/Deployment/coredns" || id == "wl:kube-system/Deployment/kube-proxy" {
			t.Errorf("a system workload should be collapsed, found %s", id)
		}
	}

	var found *graph.Node
	for i, n := range g.Nodes {
		if n.ID == "ns:kube-system" {
			found = &g.Nodes[i]
		}
	}
	if found == nil {
		t.Fatalf("kube-system should be present as one counted node: %v", ids)
	}
	if !found.System {
		t.Error("the collapsed node should say why it is collapsed")
	}
	// Counted, not hidden: the number is the whole point of collapsing rather
	// than dropping.
	if found.Workloads != 2 {
		t.Errorf("Workloads = %d, want 2", found.Workloads)
	}
}

// TestExpandingASystemNamespaceDrawsIt: the collapse has to be reversible, or
// it is a way of hiding findings rather than of ordering them.
func TestExpandingASystemNamespaceDrawsIt(t *testing.T) {
	g := graph.Build(systemCluster(t), graph.Options{
		Level:  graph.LevelWorkload,
		Expand: []string{"kube-system"},
	})
	ids := nodeIDs(g)

	for _, want := range []string{
		"wl:kube-system/Deployment/coredns",
		"wl:kube-system/Deployment/kube-proxy",
	} {
		if !slices.Contains(ids, want) {
			t.Errorf("expanding should draw %s: %v", want, ids)
		}
	}
}

// TestSystemIsConfigurable: "system" is a local judgement. A platform team's
// own namespace is system to the application teams and the whole job to them.
func TestSystemIsConfigurable(t *testing.T) {
	// An explicitly empty list means nothing is system, which is different from
	// nil meaning "use the defaults".
	none := graph.Build(systemCluster(t), graph.Options{
		Level:            graph.LevelWorkload,
		SystemNamespaces: []string{},
	})
	if !slices.Contains(nodeIDs(none), "wl:kube-system/Deployment/coredns") {
		t.Errorf("an empty system list should collapse nothing: %v", nodeIDs(none))
	}

	// And a namespace nobody upstream calls system can be named.
	custom := graph.Build(systemCluster(t), graph.Options{
		Level:            graph.LevelWorkload,
		SystemNamespaces: []string{"prod"},
	})
	if slices.Contains(nodeIDs(custom), "wl:prod/Deployment/api") {
		t.Errorf("prod was named system and should be collapsed: %v", nodeIDs(custom))
	}
}

// TestOwnNamespaceCollapses: watching yourself watch the cluster is a
// distraction from whatever you opened this to look at.
func TestOwnNamespaceCollapses(t *testing.T) {
	e := build(t,
		npeval.Namespace{Name: "marsad"},
		deploy("marsad", "marsad", "app", "marsad"),
	)
	g := graph.Build(e, graph.Options{Level: graph.LevelWorkload, OwnNamespace: "marsad"})
	if slices.Contains(nodeIDs(g), "wl:marsad/Deployment/marsad") {
		t.Errorf("Marsad's own namespace should collapse: %v", nodeIDs(g))
	}
}
