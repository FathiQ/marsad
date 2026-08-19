package graph

import "slices"

// adjacency is an undirected view of the drawn graph.
//
// Undirected on purpose: "within two hops of payments" means two hops of
// relationship, not two hops of traffic. A workload that only ever receives
// from the thing you are looking at is exactly as related to it as one that
// only sends, and a viewer asking what surrounds a node is not asking about
// direction.
func adjacency(edges []Edge) map[string][]string {
	out := make(map[string][]string, len(edges)*2)
	for _, e := range edges {
		out[e.Source] = append(out[e.Source], e.Target)
		out[e.Target] = append(out[e.Target], e.Source)
	}
	return out
}

// withinHops returns the nodes reachable from start in at most hops steps,
// including start itself.
//
// Breadth-first, so a node is recorded at its shortest distance: with a hop
// limit, finding it down a long path first and stopping there would exclude
// things that are genuinely nearer.
func withinHops(edges []Edge, start string, hops int) map[string]int {
	seen := map[string]int{start: 0}
	if hops <= 0 {
		return seen
	}

	adj := adjacency(edges)
	frontier := []string{start}
	for depth := 1; depth <= hops && len(frontier) > 0; depth++ {
		var next []string
		for _, id := range frontier {
			for _, peer := range adj[id] {
				if _, ok := seen[peer]; ok {
					continue
				}
				seen[peer] = depth
				next = append(next, peer)
			}
		}
		frontier = next
	}
	return seen
}

// outsideNodes are the peers that represent somewhere beyond the cluster.
//
// The any-node counts: a rule with no from-list admits the internet as surely
// as one naming 0.0.0.0/0, and the difference is only in how it was written.
func outsideNodes(nodes []Node) []string {
	var out []string
	for _, n := range nodes {
		switch n.Kind {
		case NodeWorld, NodeAny:
			out = append(out, n.ID)
		case NodeCIDR:
			// A named range is outside the cluster too, but a private one is
			// somebody's VPC rather than the internet, and calling that
			// "reachable from outside" would drown the finding in noise.
			if n.Public {
				out = append(out, n.ID)
			}
		}
	}
	return out
}

// ReachableFromOutside returns the cluster nodes something outside the cluster
// can reach, following edges in the direction traffic flows.
//
// Directed, unlike the focus traversal: this is a question about traffic, and a
// workload that can *call* the internet is not thereby reachable from it. That
// distinction is the whole value of the answer — conflating the two would mark
// every workload with egress as exposed and make the filter useless.
func ReachableFromOutside(g *Graph) []string {
	starts := outsideNodes(g.Nodes)
	if len(starts) == 0 {
		return nil
	}

	forward := make(map[string][]string, len(g.Edges))
	for _, e := range g.Edges {
		forward[e.Source] = append(forward[e.Source], e.Target)
	}

	seen := map[string]bool{}
	queue := slices.Clone(starts)
	for _, id := range starts {
		seen[id] = true
	}
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		for _, peer := range forward[id] {
			if seen[peer] {
				continue
			}
			seen[peer] = true
			queue = append(queue, peer)
		}
	}

	// The starting points are not an answer to "what can be reached", and the
	// caller is asking about their own cluster.
	out := make([]string, 0, len(seen))
	for _, n := range g.Nodes {
		if n.Kind != NodeWorkload && n.Kind != NodeNamespace {
			continue
		}
		if seen[n.ID] {
			out = append(out, n.ID)
		}
	}
	slices.Sort(out)
	return out
}
