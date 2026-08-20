package graph

import (
	"slices"

	"github.com/FathiQ/marsad/pkg/npeval"
)

// maxPeerWorkloads bounds how many individual workload nodes one peer may
// expand into. A rule like "allow from all pods in all namespaces" resolves to
// every workload in the cluster; drawing that literally produces a hairball that
// tells the user less than a single collapsed edge does.
const maxPeerWorkloads = 24

type builder struct {
	eval *npeval.Evaluator
	opts Options

	scope    map[string]bool // namespaces in view; nil means everything
	system   map[string]bool // namespaces collapsed unless expanded
	nodes    map[string]*Node
	edges    map[string]*Edge
	order    []string
	edgeSeq  []string
	truncate bool

	emptyNamespaces []string
}

// Build renders the current evaluation as a graph.
func Build(e *npeval.Evaluator, opts Options) *Graph {
	if opts.Level == "" {
		opts.Level = LevelNamespace
	}

	b := &builder{
		eval:   e,
		opts:   opts,
		system: systemSet(opts.SystemNamespaces, opts.OwnNamespace),
		nodes:  map[string]*Node{},
		edges:  map[string]*Edge{},
	}
	if len(opts.Namespaces) > 0 {
		b.scope = map[string]bool{}
		for _, ns := range opts.Namespaces {
			b.scope[ns] = true
		}
	}

	snap := e.Snapshot()

	// Namespace nodes are seeded only for the namespace-level view, where an
	// empty namespace is still worth showing. At workload level they are created
	// on demand for collapsed peers; seeding them all leaves a scatter of
	// disconnected namespace nodes floating beside the workloads they contain.
	if opts.Level == LevelNamespace {
		for _, ns := range snap.Namespaces() {
			if !b.inScope(ns.Name) {
				continue
			}
			// A namespace with nothing in it has no posture to show and no
			// edges to place it, so it lands wherever the layout puts an
			// unconnected node — which is through the middle of everything
			// else. Reported instead, and drawn on request.
			if !opts.IncludeEmpty && len(snap.Workloads(ns.Name)) == 0 {
				b.emptyNamespaces = append(b.emptyNamespaces, ns.Name)
				continue
			}
			b.namespaceNode(ns.Name)
		}
	}

	for _, w := range snap.Workloads("") {
		if !b.inScope(w.Ref.Namespace) {
			continue
		}
		b.addWorkload(w)
	}

	g := &Graph{
		Level:           opts.Level,
		Namespaces:      opts.Namespaces,
		Truncated:       b.truncate,
		EmptyNamespaces: b.emptyNamespaces,
		Nodes:           make([]Node, 0, len(b.order)),
		Edges:           make([]Edge, 0, len(b.edgeSeq)),
	}
	for _, id := range b.order {
		g.Nodes = append(g.Nodes, *b.nodes[id])
	}
	for _, id := range b.edgeSeq {
		e := b.edges[id]
		slices.Sort(e.Via)
		e.Via = slices.Compact(e.Via)
		// An allowed-by-default edge has no rules behind it, and a nil slice
		// marshals to null rather than []. The field is declared as an array, so
		// emitting null breaks every client that believes the contract.
		if e.Via == nil {
			e.Via = []npeval.RuleID{}
		}
		g.Edges = append(g.Edges, *e)
	}

	// Marked before focus narrows anything: whether the internet can reach a
	// workload is a fact about the cluster, not about what is currently on
	// screen, and computing it after focus would make it change as you look
	// around.
	exposed := ReachableFromOutside(g)
	if len(exposed) > 0 {
		reach := make(map[string]bool, len(exposed))
		for _, id := range exposed {
			reach[id] = true
		}
		for i := range g.Nodes {
			g.Nodes[i].Exposed = reach[g.Nodes[i].ID]
		}
	}

	if opts.Focus != "" {
		applyFocus(g, opts.Focus, opts.FocusHops)
	}
	return g
}

// MaxDrawableNodes is where a graph stops being a picture.
//
// Past this the layout is a hairball and no amount of panning recovers it, so
// the honest response is to refuse and say why — offering focus or search —
// rather than to draw it and let somebody discover it is unreadable. Chosen to
// sit above any namespace-level view and above a workload-level view of a
// normal cluster, so it only fires where it means something.
const MaxDrawableNodes = 220

// Oversized reports whether a graph is too large to draw, replacing its
// contents with a count. Called by the server rather than by Build, so a caller
// that genuinely wants everything — an export, a test — still gets it.
func (g *Graph) Oversized() bool {
	if len(g.Nodes) <= MaxDrawableNodes {
		return false
	}
	g.Oversize = &Oversize{Nodes: len(g.Nodes), Limit: MaxDrawableNodes}
	g.Nodes = nil
	g.Edges = nil
	return true
}

// applyFocus reduces a built graph to one node's neighbourhood, folding what is
// left out into counted cluster nodes.
//
// Reduced after building rather than during it, because "within two hops" is a
// question about the finished graph: which nodes are adjacent depends on which
// edges survived peer collapsing and port merging, and those are decided by the
// build. Doing it earlier would answer a slightly different question that
// happens to look the same on small inputs.
func applyFocus(g *Graph, focus string, hops int) {
	if hops <= 0 {
		hops = DefaultFocusHops
	}

	byID := make(map[string]Node, len(g.Nodes))
	namespaces := map[string]bool{}
	workloads := 0
	for _, n := range g.Nodes {
		byID[n.ID] = n
		if n.Namespace != "" {
			namespaces[n.Namespace] = true
		}
		if n.Kind == NodeWorkload {
			workloads++
		}
	}
	if _, ok := byID[focus]; !ok {
		// Focusing on something that is not drawn would empty the graph and
		// look like a bug in the data rather than a stale request.
		return
	}

	keep := withinHops(g.Edges, focus, hops)

	kept := make([]Node, 0, len(keep))
	keptNamespaces := map[string]bool{}
	keptWorkloads := 0
	// Namespaces that lost every node, counted so the cluster card can say how
	// many places are not being shown rather than only how many nodes.
	dropped := map[string]int{}

	for _, n := range g.Nodes {
		if _, in := keep[n.ID]; in {
			kept = append(kept, n)
			if n.Namespace != "" {
				keptNamespaces[n.Namespace] = true
			}
			if n.Kind == NodeWorkload {
				keptWorkloads++
			}
			continue
		}
		where := n.Namespace
		if where == "" {
			where = string(n.Kind)
		}
		dropped[where]++
	}

	hidden := len(g.Nodes) - len(kept)
	if hidden > 0 {
		// One card for everything excluded, rather than nothing at all. A graph
		// that silently shows a tenth of a cluster is worse than one that shows
		// a tenth and says so.
		hiddenNamespaces := 0
		for ns := range dropped {
			if !keptNamespaces[ns] {
				hiddenNamespaces++
			}
		}
		kept = append(kept, Node{
			ID:         "cluster:hidden",
			Kind:       NodeNamespace,
			Label:      "elsewhere",
			Hidden:     true,
			Workloads:  hidden,
			Namespaces: hiddenNamespaces,
		})
	}

	keptEdges := make([]Edge, 0, len(g.Edges))
	for _, e := range g.Edges {
		_, s := keep[e.Source]
		_, t := keep[e.Target]
		if s && t {
			keptEdges = append(keptEdges, e)
		}
	}

	g.Nodes = kept
	g.Edges = keptEdges
	g.Focus = &Focus{
		Node:            focus,
		Hops:            hops,
		Namespaces:      len(keptNamespaces),
		TotalNamespaces: len(namespaces),
		Workloads:       keptWorkloads,
		TotalWorkloads:  workloads,
		Hidden:          hidden,
	}
}

func (b *builder) inScope(namespace string) bool {
	return b.scope == nil || b.scope[namespace]
}

func (b *builder) node(id string, make func() Node) *Node {
	if n, ok := b.nodes[id]; ok {
		return n
	}
	n := make()
	n.ID = id
	b.nodes[id] = &n
	b.order = append(b.order, id)
	return &n
}

func (b *builder) namespaceNode(name string) *Node {
	system := b.isSystem(name)
	return b.node(nsID(name), func() Node {
		return Node{Kind: NodeNamespace, Label: name, Namespace: name, System: system}
	})
}

// clusterNodeID is the node a workload maps to at the current level.
func (b *builder) clusterNodeID(w npeval.Workload) string {
	if b.opts.Level == LevelWorkload && b.inScope(w.Ref.Namespace) && !b.isSystem(w.Ref.Namespace) {
		return workloadID(w.Ref)
	}
	return nsID(w.Ref.Namespace)
}

func (b *builder) addWorkload(w npeval.Workload) {
	iso := b.eval.Isolation(w.Ref)
	id := b.clusterNodeID(w)

	if b.opts.Level == LevelWorkload && b.inScope(w.Ref.Namespace) && !b.isSystem(w.Ref.Namespace) {
		n := b.node(id, func() Node {
			return Node{
				Kind:         NodeWorkload,
				Label:        w.Ref.Name,
				Namespace:    w.Ref.Namespace,
				WorkloadKind: string(w.Kind),
				Replicas:     w.Replicas,
			}
		})
		n.Isolation = &Isolation{Ingress: iso.Ingress, Egress: iso.Egress}
	} else {
		// A namespace is only as protected as its least protected workload, so
		// isolation is ANDed across the members rather than ORed.
		n := b.namespaceNode(w.Ref.Namespace)
		if n.Isolation == nil {
			n.Isolation = &Isolation{Ingress: true, Egress: true}
		}
		n.Isolation.Ingress = n.Isolation.Ingress && iso.Ingress
		n.Isolation.Egress = n.Isolation.Egress && iso.Egress
		n.Workloads++
		if !iso.Ingress && !iso.Egress {
			n.Unprotected++
		}
	}

	b.addDirection(w, id, npeval.DirIngress)
	b.addDirection(w, id, npeval.DirEgress)
}

func (b *builder) addDirection(w npeval.Workload, selfID string, dir npeval.Direction) {
	eff := b.eval.Effective(w.Ref, dir)

	if !eff.Isolated {
		if !b.opts.IncludeDefault {
			return
		}
		// Nothing governs this direction, so everything is permitted. Drawn as a
		// dashed edge to the "any" node: the absence of a policy, not a rule.
		anyID := b.node(peerNodeID(NodeAny, "all"), func() Node {
			return Node{Kind: NodeAny, Label: string(NodeAny)}
		}).ID
		b.link(anyID, selfID, dir, EdgeDefault, nil, nil, "no policy isolates this workload")
		return
	}

	for _, allow := range eff.Allows {
		kind := EdgeAllowed
		if allow.Approximate {
			kind = EdgeApproximate
		}
		ports := portLabels(allow.Ports)
		dns := onlyDNS(allow.Ports)

		for _, peerID := range b.peerNodes(allow.Peer) {
			b.link(peerID, selfID, dir, kind, ports, allow.Via, allow.Note)
			if dns {
				b.markDNS(peerID, selfID, dir, kind)
			}
		}
	}
}

// link adds an edge oriented so it always points the way traffic flows.
func (b *builder) link(peerID, selfID string, dir npeval.Direction, kind EdgeKind, ports []string, via []npeval.RuleID, note string) {
	source, target := peerID, selfID
	if dir == npeval.DirEgress {
		source, target = selfID, peerID
	}
	if source == target {
		// Intra-node traffic — a namespace allowed to talk to itself once
		// collapsed. Real, but a self-loop adds noise without information.
		return
	}

	id := edgeID(source, target, kind)
	e, ok := b.edges[id]
	if !ok {
		e = &Edge{ID: id, Source: source, Target: target, Kind: kind, Ports: ports, Note: note}
		b.edges[id] = e
		b.edgeSeq = append(b.edgeSeq, id)
	} else {
		e.Ports = joinPorts(e.Ports, ports)
		if e.Note == "" {
			e.Note = note
		}
	}
	e.Via = append(e.Via, via...)
}

func (b *builder) markDNS(peerID, selfID string, dir npeval.Direction, kind EdgeKind) {
	source, target := peerID, selfID
	if dir == npeval.DirEgress {
		source, target = selfID, peerID
	}
	if e, ok := b.edges[edgeID(source, target, kind)]; ok && len(e.Ports) > 0 {
		e.DNS = true
	}
}

// peerNodes maps a resolved peer to the node or nodes it should draw as.
func (b *builder) peerNodes(p npeval.ResolvedPeer) []string {
	switch p.Kind {
	case npeval.PeerAny:
		return []string{b.node(peerNodeID(NodeAny, "all"), func() Node {
			return Node{Kind: NodeAny, Label: string(NodeAny)}
		}).ID}

	case npeval.PeerCIDR:
		kind, label := NodeCIDR, p.CIDR.String()
		if isWorld(p.CIDR) {
			kind, label = NodeWorld, "World "+p.CIDR.String()
		}
		id := peerNodeID(kind, p.CIDR.String())
		display := p.Display
		public := isPublic(p.CIDR)
		return []string{b.node(id, func() Node {
			return Node{
				Kind:   kind,
				Label:  shortLabel(orDefault(display, label), 48),
				Public: public,
			}
		}).ID}

	case npeval.PeerDomain:
		domain := p.Domain
		return []string{b.node(peerNodeID(NodeDomain, domain), func() Node {
			return Node{Kind: NodeDomain, Label: domain}
		}).ID}

	case npeval.PeerPods:
		return b.podPeerNodes(p)

	default:
		return nil
	}
}

// podPeerNodes expands a pod peer, collapsing anything out of scope — or any
// peer too broad to draw individually — to namespace nodes.
func (b *builder) podPeerNodes(p npeval.ResolvedPeer) []string {
	collapse := b.opts.Level != LevelWorkload || len(p.Workloads) > maxPeerWorkloads
	if len(p.Workloads) > maxPeerWorkloads {
		b.truncate = true
	}

	seen := map[string]bool{}
	var out []string
	addNamespace := func(ns string) {
		id := b.namespaceNode(ns).ID
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}

	if collapse {
		for _, ns := range p.Namespaces {
			addNamespace(ns)
		}
		// A peer can resolve to workloads in namespaces the selector list does
		// not name, so take both.
		for _, ref := range p.Workloads {
			addNamespace(ref.Namespace)
		}
		return out
	}

	for _, ref := range p.Workloads {
		if !b.inScope(ref.Namespace) {
			addNamespace(ref.Namespace)
			continue
		}
		w, ok := b.eval.Snapshot().Workload(ref)
		if !ok {
			continue
		}
		id := b.node(workloadID(ref), func() Node {
			return Node{
				Kind:         NodeWorkload,
				Label:        ref.Name,
				Namespace:    ref.Namespace,
				WorkloadKind: string(w.Kind),
				Replicas:     w.Replicas,
			}
		}).ID
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}

	// A peer that selects a namespace containing nothing is still a real
	// allowance, and worth drawing — the namespace may fill up later.
	if len(out) == 0 {
		for _, ns := range p.Namespaces {
			addNamespace(ns)
		}
	}
	return out
}

func orDefault(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}
