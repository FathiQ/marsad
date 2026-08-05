import type { EdgeKind, Graph, GraphNode } from '../api'

/**
 * Filters applied in the browser, on top of the namespace scope the server
 * already applies.
 *
 * The split is deliberate. Namespace scope changes which workloads the evaluator
 * even considers, so it belongs on the server. Everything here is a question
 * about the graph you already have — "hide the noise", "show me only what is
 * unprotected" — and answering those locally keeps them instant instead of
 * costing a round trip per checkbox.
 */
export interface Filters {
  edgeKinds: Set<EdgeKind>
  workloadKinds: Set<string>
  hideDNS: boolean
  onlyUnprotected: boolean
  hideIsolatedNodes: boolean
}

export const ALL_EDGE_KINDS: EdgeKind[] = ['allowed', 'approximate', 'default']

export const defaultFilters = (): Filters => ({
  edgeKinds: new Set(ALL_EDGE_KINDS),
  workloadKinds: new Set(),
  hideDNS: false,
  onlyUnprotected: false,
  // Off by default: a node with no edges is usually the finding, not clutter.
  hideIsolatedNodes: false,
})

export function isUnprotectedNode(node: GraphNode): boolean {
  if (node.kind === 'namespace') return (node.unprotected ?? 0) > 0
  if (node.kind === 'workload') {
    return node.isolation ? !node.isolation.ingress && !node.isolation.egress : false
  }
  return false
}

/** The workload kinds actually present, so the filter never offers an option
 * that would empty the graph. */
export function presentWorkloadKinds(graph: Graph | null): string[] {
  const kinds = new Set<string>()
  for (const n of graph?.nodes ?? []) {
    if (n.kind === 'workload' && n.workloadKind) kinds.add(n.workloadKind)
  }
  return [...kinds].sort()
}

export function applyFilters(graph: Graph, filters: Filters): Graph {
  const keptNodes = graph.nodes.filter((n) => {
    if (filters.onlyUnprotected && (n.kind === 'workload' || n.kind === 'namespace')) {
      if (!isUnprotectedNode(n)) return false
    }
    if (filters.workloadKinds.size > 0 && n.kind === 'workload') {
      if (!n.workloadKind || !filters.workloadKinds.has(n.workloadKind)) return false
    }
    return true
  })

  const ids = new Set(keptNodes.map((n) => n.id))

  const keptEdges = graph.edges.filter((e) => {
    if (!ids.has(e.source) || !ids.has(e.target)) return false
    if (!filters.edgeKinds.has(e.kind)) return false
    if (filters.hideDNS && e.dns) return false
    return true
  })

  let nodes = keptNodes
  if (filters.hideIsolatedNodes) {
    const connected = new Set<string>()
    for (const e of keptEdges) {
      connected.add(e.source)
      connected.add(e.target)
    }
    nodes = keptNodes.filter((n) => connected.has(n.id))
  }

  return { ...graph, nodes, edges: keptEdges }
}

/** How many of the original elements a filter set is hiding, so the UI can say
 * so rather than leaving someone to wonder where their workloads went. */
export function hiddenCount(original: Graph, filtered: Graph): number {
  return original.nodes.length - filtered.nodes.length
}
