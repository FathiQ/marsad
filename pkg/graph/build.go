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
	nodes    map[string]*Node
	edges    map[string]*Edge
	order    []string
	edgeSeq  []string
	truncate bool
}

// Build renders the current evaluation as a graph.
func Build(e *npeval.Evaluator, opts Options) *Graph {
	if opts.Level == "" {
		opts.Level = LevelNamespace
	}

	b := &builder{
		eval:  e,
		opts:  opts,
		nodes: map[string]*Node{},
		edges: map[string]*Edge{},
	}
	if len(opts.Namespaces) > 0 {
		b.scope = map[string]bool{}
		for _, ns := range opts.Namespaces {
			b.scope[ns] = true
		}
	}

	snap := e.Snapshot()
	for _, ns := range snap.Namespaces() {
		if b.inScope(ns.Name) {
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
		Level:      opts.Level,
		Namespaces: opts.Namespaces,
		Truncated:  b.truncate,
		Nodes:      make([]Node, 0, len(b.order)),
		Edges:      make([]Edge, 0, len(b.edgeSeq)),
	}
	for _, id := range b.order {
		g.Nodes = append(g.Nodes, *b.nodes[id])
	}
	for _, id := range b.edgeSeq {
		e := b.edges[id]
		slices.Sort(e.Via)
		e.Via = slices.Compact(e.Via)
		g.Edges = append(g.Edges, *e)
	}
	return g
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
	return b.node(nsID(name), func() Node {
		return Node{Kind: NodeNamespace, Label: name, Namespace: name}
	})
}

// clusterNodeID is the node a workload maps to at the current level.
func (b *builder) clusterNodeID(w npeval.Workload) string {
	if b.opts.Level == LevelWorkload && b.inScope(w.Ref.Namespace) {
		return workloadID(w.Ref)
	}
	return nsID(w.Ref.Namespace)
}

func (b *builder) addWorkload(w npeval.Workload) {
	iso := b.eval.Isolation(w.Ref)
	id := b.clusterNodeID(w)

	if b.opts.Level == LevelWorkload && b.inScope(w.Ref.Namespace) {
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
		return []string{b.node(id, func() Node {
			return Node{Kind: kind, Label: shortLabel(orDefault(display, label), 48)}
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
