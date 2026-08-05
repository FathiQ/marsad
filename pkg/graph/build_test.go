package graph_test

import (
	"slices"
	"strings"
	"testing"

	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"

	"github.com/FathiQ/marsad/pkg/graph"
	"github.com/FathiQ/marsad/pkg/npeval"
	"github.com/FathiQ/marsad/pkg/npeval/provider/k8s"
)

func sel(kv ...string) *metav1.LabelSelector {
	m := map[string]string{}
	for i := 0; i < len(kv); i += 2 {
		m[kv[i]] = kv[i+1]
	}
	return &metav1.LabelSelector{MatchLabels: m}
}

func deploy(ns, name string, kv ...string) npeval.Workload {
	m := map[string]string{}
	for i := 0; i < len(kv); i += 2 {
		m[kv[i]] = kv[i+1]
	}
	return npeval.Workload{
		Ref:      npeval.ObjectRef{Group: "apps", Kind: "Deployment", Namespace: ns, Name: name},
		Kind:     npeval.KindDeployment,
		Labels:   m,
		Replicas: 2,
	}
}

func port(n int32) *intstr.IntOrString { v := intstr.FromInt32(n); return &v }

func build(t *testing.T, objs ...any) *npeval.Evaluator {
	t.Helper()
	b := npeval.NewBuilder()
	for _, o := range objs {
		switch v := o.(type) {
		case npeval.Namespace:
			b.AddNamespace(v)
		case npeval.Workload:
			b.AddWorkload(v)
		case *networkingv1.NetworkPolicy:
			p, err := k8s.NormalizePolicy(v)
			if err != nil {
				t.Fatalf("normalize: %v", err)
			}
			b.AddPolicy(p)
		default:
			t.Fatalf("unsupported %T", o)
		}
	}
	snap, err := b.Build()
	if err != nil {
		t.Fatal(err)
	}
	return npeval.New(snap)
}

func netpol(ns, name string, spec networkingv1.NetworkPolicySpec) *networkingv1.NetworkPolicy {
	return &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name},
		Spec:       spec,
	}
}

func nodeIDs(g *graph.Graph) []string {
	out := make([]string, 0, len(g.Nodes))
	for _, n := range g.Nodes {
		out = append(out, n.ID)
	}
	slices.Sort(out)
	return out
}

func findNode(g *graph.Graph, id string) *graph.Node {
	for i := range g.Nodes {
		if g.Nodes[i].ID == id {
			return &g.Nodes[i]
		}
	}
	return nil
}

func edgeStrings(g *graph.Graph) []string {
	out := make([]string, 0, len(g.Edges))
	for _, e := range g.Edges {
		out = append(out, e.Source+" -> "+e.Target+" ["+string(e.Kind)+"]")
	}
	slices.Sort(out)
	return out
}

// The default view is per namespace, because that is the only level that stays
// readable on a cluster with thousands of pods.
func TestNamespaceLevelCollapsesWorkloads(t *testing.T) {
	e := build(t,
		npeval.Namespace{Name: "prod"},
		npeval.Namespace{Name: "edge", Labels: map[string]string{"tier": "edge"}},
		deploy("prod", "api", "app", "api"),
		deploy("prod", "db", "app", "db"),
		deploy("edge", "web", "app", "web"),
		netpol("prod", "api-ingress", networkingv1.NetworkPolicySpec{
			PodSelector: *sel("app", "api"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			Ingress: []networkingv1.NetworkPolicyIngressRule{{
				From:  []networkingv1.NetworkPolicyPeer{{NamespaceSelector: sel("tier", "edge")}},
				Ports: []networkingv1.NetworkPolicyPort{{Port: port(8080)}},
			}},
		}),
	)

	g := graph.Build(e, graph.Options{Level: graph.LevelNamespace})

	for _, id := range nodeIDs(g) {
		if strings.HasPrefix(id, "wl:") {
			t.Errorf("namespace level should not contain workload nodes, found %s", id)
		}
	}
	if !slices.Contains(edgeStrings(g), "ns:edge -> ns:prod [allowed]") {
		t.Errorf("expected an edge from edge to prod, got %v", edgeStrings(g))
	}
}

// A namespace is only as protected as its least protected workload, so one
// unprotected workload has to show at the namespace level.
func TestNamespaceIsolationIsConservative(t *testing.T) {
	e := build(t,
		npeval.Namespace{Name: "prod"},
		deploy("prod", "api", "app", "api"),
		deploy("prod", "legacy", "app", "legacy"),
		netpol("prod", "api-only", networkingv1.NetworkPolicySpec{
			PodSelector: *sel("app", "api"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress, networkingv1.PolicyTypeEgress},
		}),
	)

	g := graph.Build(e, graph.Options{Level: graph.LevelNamespace})
	n := findNode(g, "ns:prod")
	if n == nil {
		t.Fatal("no prod node")
	}
	if n.Isolation == nil || n.Isolation.Ingress {
		t.Errorf("prod must not read as isolated while legacy is unprotected: %+v", n.Isolation)
	}
	if n.Unprotected != 1 {
		t.Errorf("got %d unprotected, want 1", n.Unprotected)
	}
	if n.Workloads != 2 {
		t.Errorf("got %d workloads, want 2", n.Workloads)
	}
}

func TestWorkloadLevelExpandsInScopeOnly(t *testing.T) {
	e := build(t,
		npeval.Namespace{Name: "prod"},
		npeval.Namespace{Name: "edge", Labels: map[string]string{"tier": "edge"}},
		deploy("prod", "api", "app", "api"),
		deploy("edge", "web", "app", "web"),
		netpol("prod", "api-ingress", networkingv1.NetworkPolicySpec{
			PodSelector: *sel("app", "api"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			Ingress: []networkingv1.NetworkPolicyIngressRule{{
				From: []networkingv1.NetworkPolicyPeer{{NamespaceSelector: sel("tier", "edge")}},
			}},
		}),
	)

	g := graph.Build(e, graph.Options{Level: graph.LevelWorkload, Namespaces: []string{"prod"}})

	ids := nodeIDs(g)
	if !slices.Contains(ids, "wl:prod/Deployment/api") {
		t.Errorf("prod/api should be a workload node, got %v", ids)
	}
	// edge is out of scope, so its workloads collapse into the namespace rather
	// than dragging the whole cluster into view.
	if slices.Contains(ids, "wl:edge/Deployment/web") {
		t.Errorf("out-of-scope workloads should collapse to their namespace, got %v", ids)
	}
	if !slices.Contains(ids, "ns:edge") {
		t.Errorf("expected a collapsed edge namespace node, got %v", ids)
	}
}

// Edges point the way traffic flows, regardless of which side declared the rule.
func TestEdgeDirection(t *testing.T) {
	e := build(t,
		npeval.Namespace{Name: "prod"},
		deploy("prod", "api", "app", "api"),
		deploy("prod", "db", "app", "db"),
		netpol("prod", "api-egress", networkingv1.NetworkPolicySpec{
			PodSelector: *sel("app", "api"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
			Egress: []networkingv1.NetworkPolicyEgressRule{{
				To:    []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "db")}},
				Ports: []networkingv1.NetworkPolicyPort{{Port: port(5432)}},
			}},
		}),
	)

	g := graph.Build(e, graph.Options{Level: graph.LevelWorkload, IncludeDefault: false})
	want := "wl:prod/Deployment/api -> wl:prod/Deployment/db [allowed]"
	if !slices.Contains(edgeStrings(g), want) {
		t.Errorf("got %v, want %q", edgeStrings(g), want)
	}
}

func TestWorldAndDomainNodes(t *testing.T) {
	e := build(t,
		npeval.Namespace{Name: "prod"},
		deploy("prod", "api", "app", "api"),
		netpol("prod", "api-egress", networkingv1.NetworkPolicySpec{
			PodSelector: *sel("app", "api"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
			Egress: []networkingv1.NetworkPolicyEgressRule{{
				To:    []networkingv1.NetworkPolicyPeer{{IPBlock: &networkingv1.IPBlock{CIDR: "0.0.0.0/0"}}},
				Ports: []networkingv1.NetworkPolicyPort{{Port: port(443)}},
			}},
		}),
	)

	g := graph.Build(e, graph.Options{Level: graph.LevelWorkload, IncludeDefault: false})
	n := findNode(g, "world:0.0.0.0/0")
	if n == nil {
		t.Fatalf("expected a world node, got %v", nodeIDs(g))
	}
	// 0.0.0.0/0 gets its own node kind because reaching it is usually the
	// finding, not an ordinary CIDR allowance.
	if n.Kind != graph.NodeWorld {
		t.Errorf("got kind %q, want world", n.Kind)
	}
}

// Traffic permitted only by the absence of policy is drawn differently, and can
// be switched off — on a cluster with no policies it would otherwise be every
// workload.
func TestDefaultAllowedEdges(t *testing.T) {
	objs := []any{npeval.Namespace{Name: "prod"}, deploy("prod", "api", "app", "api")}

	with := graph.Build(build(t, objs...), graph.Options{Level: graph.LevelWorkload, IncludeDefault: true})
	if len(with.Edges) == 0 {
		t.Fatal("expected dashed default edges")
	}
	for _, e := range with.Edges {
		if e.Kind != graph.EdgeDefault {
			t.Errorf("got edge kind %q, want default", e.Kind)
		}
	}

	without := graph.Build(build(t, objs...), graph.Options{Level: graph.LevelWorkload, IncludeDefault: false})
	if len(without.Edges) != 0 {
		t.Errorf("got %v, want no edges", edgeStrings(without))
	}
}

func TestDNSEdgesAreMarked(t *testing.T) {
	e := build(t,
		npeval.Namespace{Name: "prod"},
		npeval.Namespace{Name: "kube-system", Labels: map[string]string{"name": "kube-system"}},
		deploy("prod", "api", "app", "api"),
		deploy("kube-system", "coredns", "k8s-app", "kube-dns"),
		netpol("prod", "dns", networkingv1.NetworkPolicySpec{
			PodSelector: *sel("app", "api"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
			Egress: []networkingv1.NetworkPolicyEgressRule{{
				To: []networkingv1.NetworkPolicyPeer{{
					NamespaceSelector: sel("name", "kube-system"),
					PodSelector:       sel("k8s-app", "kube-dns"),
				}},
				Ports: []networkingv1.NetworkPolicyPort{{Port: port(53)}},
			}},
		}),
	)

	g := graph.Build(e, graph.Options{Level: graph.LevelWorkload, Namespaces: []string{"prod", "kube-system"}, IncludeDefault: false})
	var found bool
	for _, edge := range g.Edges {
		if edge.DNS {
			found = true
		}
	}
	if !found {
		t.Errorf("a port-53-only edge should be marked as DNS: %+v", g.Edges)
	}
}

// Every edge must name the rules behind it: clicking an edge and being shown the
// exact YAML is the feature the whole tool exists for.
func TestEdgesCarryTraceability(t *testing.T) {
	e := build(t,
		npeval.Namespace{Name: "prod"},
		deploy("prod", "api", "app", "api"),
		deploy("prod", "web", "app", "web"),
		netpol("prod", "api-ingress", networkingv1.NetworkPolicySpec{
			PodSelector: *sel("app", "api"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			Ingress: []networkingv1.NetworkPolicyIngressRule{{
				From: []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "web")}},
			}},
		}),
	)

	g := graph.Build(e, graph.Options{Level: graph.LevelWorkload, IncludeDefault: false})
	if len(g.Edges) == 0 {
		t.Fatal("expected an edge")
	}
	for _, edge := range g.Edges {
		if len(edge.Via) == 0 {
			t.Errorf("edge %s has no rule references", edge.ID)
			continue
		}
		if !strings.Contains(string(edge.Via[0]), "api-ingress#ingress[0]") {
			t.Errorf("got %v, want the originating rule", edge.Via)
		}
	}
}

// A peer matching everything would otherwise expand into one node per workload
// in the cluster, which renders as a hairball and says less than one edge does.
func TestBroadPeersCollapseAndSaySo(t *testing.T) {
	objs := []any{npeval.Namespace{Name: "prod"}, deploy("prod", "api", "app", "api")}
	for i := 0; i < 40; i++ {
		objs = append(objs, deploy("prod", "svc-"+string(rune('a'+i%26))+string(rune('a'+i/26)), "app", "bulk"))
	}
	objs = append(objs, netpol("prod", "wide", networkingv1.NetworkPolicySpec{
		PodSelector: *sel("app", "api"),
		PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
		Ingress: []networkingv1.NetworkPolicyIngressRule{{
			From: []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "bulk")}},
		}},
	}))

	g := graph.Build(build(t, objs...), graph.Options{Level: graph.LevelWorkload, IncludeDefault: false})
	if !g.Truncated {
		t.Error("a collapsed peer must be reported, not silently hidden")
	}
	if !slices.Contains(nodeIDs(g), "ns:prod") {
		t.Errorf("expected the peer to collapse to a namespace node, got %v", nodeIDs(g))
	}
}

// Seeding a node for every namespace at workload level leaves a scatter of
// empty namespace nodes beside the workloads they contain.
func TestWorkloadLevelOmitsUnusedNamespaceNodes(t *testing.T) {
	e := build(t,
		npeval.Namespace{Name: "prod"},
		npeval.Namespace{Name: "empty"},
		npeval.Namespace{Name: "unrelated"},
		deploy("prod", "api", "app", "api"),
	)

	g := graph.Build(e, graph.Options{Level: graph.LevelWorkload, IncludeDefault: false})
	for _, id := range nodeIDs(g) {
		if strings.HasPrefix(id, "ns:") {
			t.Errorf("workload level should not seed namespace nodes, found %s", id)
		}
	}

	// The namespace-level view still shows an empty namespace, because there it
	// is the unit being drawn.
	ns := graph.Build(e, graph.Options{Level: graph.LevelNamespace, IncludeDefault: false})
	if !slices.Contains(nodeIDs(ns), "ns:empty") {
		t.Errorf("namespace level should show empty namespaces, got %v", nodeIDs(ns))
	}
}

func TestScopeFiltersNamespaces(t *testing.T) {
	e := build(t,
		npeval.Namespace{Name: "prod"},
		npeval.Namespace{Name: "other"},
		deploy("prod", "api", "app", "api"),
		deploy("other", "thing", "app", "thing"),
	)

	g := graph.Build(e, graph.Options{Level: graph.LevelNamespace, Namespaces: []string{"prod"}})
	if slices.Contains(nodeIDs(g), "ns:other") {
		t.Errorf("out-of-scope namespaces should not appear unprompted: %v", nodeIDs(g))
	}
}
