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

/**
 * How many edges of each kind the unfiltered graph holds.
 *
 * Shown beside each connection toggle so the cost of turning one off is visible
 * before it is paid. "Allowed by a rule" with 4 beside it and "depends on DNS"
 * with 61 are very different decisions, and a checkbox alone says neither.
 *
 * `default` can be absent rather than zero: those edges are omitted by the
 * server when includeDefault is off, so the graph in hand genuinely does not
 * know how many there would be. Zero would be a lie, and on this screen a
 * confident wrong number is worse than no number.
 */
export function edgeKindCounts(
  graph: Graph | null,
  includeDefault: boolean,
): Partial<Record<EdgeKind, number>> {
  const counts: Partial<Record<EdgeKind, number>> = { allowed: 0, approximate: 0 }
  if (includeDefault) counts.default = 0
  for (const e of graph?.edges ?? []) {
    if (e.kind === 'default' && !includeDefault) continue
    counts[e.kind] = (counts[e.kind] ?? 0) + 1
  }
  return counts
}

/** Workloads drawn versus workloads the graph holds, for the rail's footer. */
export function workloadCounts(original: Graph | null, filtered: Graph | null) {
  const count = (g: Graph | null) => (g?.nodes ?? []).filter((n) => n.kind === 'workload').length
  return { shown: count(filtered), total: count(original) }
}

/**
 * Whether the filters are actually hiding anything.
 *
 * Drives the badge on the collapsed row. A badge that is always lit is
 * decoration, and worse than decoration here: the one thing it has to be able
 * to say is "part of the picture is missing", and it cannot say that if it
 * looks the same when nothing is.
 */
export function isHiding(
  original: Graph | null,
  filtered: Graph | null,
  includeDefault: boolean,
): boolean {
  if (!includeDefault) return true
  if (!original || !filtered) return false
  return filtered.nodes.length < original.nodes.length || filtered.edges.length < original.edges.length
}
