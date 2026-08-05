/// <reference lib="webworker" />
import dagre from '@dagrejs/dagre'

/**
 * Layered left-to-right layout.
 *
 * Force-directed was the wrong choice and it showed: it produces a hairball
 * where every edge crosses every other, and no amount of node styling rescues
 * that. Policy is directional — sources reach destinations — so a layered layout
 * puts callers on the left and callees on the right and the picture becomes
 * readable on its own.
 *
 * Dagre needs each node's real dimensions to reserve space, so the caller
 * measures the cards on the main thread (text metrics need a canvas) and passes
 * them in. Running the layout here keeps a large graph from freezing the canvas.
 */

export interface LayoutNode {
  id: string
  width: number
  height: number
  /** Nodes sharing a group are kept together, so a namespace stays contiguous
   * rather than being scattered across the diagram. */
  group?: string
}

export interface LayoutRequest {
  nodes: LayoutNode[]
  edges: { source: string; target: string }[]
}

export type LayoutResult = Record<string, { x: number; y: number }>

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const { nodes, edges } = event.data
  const post = (result: LayoutResult) => (self as unknown as Worker).postMessage(result)

  if (nodes.length === 0) {
    post({})
    return
  }

  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true })
  g.setGraph({
    rankdir: 'LR',
    // Generous separation: cards are wide, and the whole point of the layered
    // layout is that edges have room to be followed.
    nodesep: 34,
    ranksep: 130,
    edgesep: 18,
    marginx: 60,
    marginy: 60,
    ranker: 'network-simplex',
  })
  g.setDefaultEdgeLabel(() => ({}))

  const groups = new Set<string>()
  for (const n of nodes) {
    if (n.group) groups.add(n.group)
  }
  for (const group of groups) {
    g.setNode(`__group__${group}`, {})
  }

  for (const n of nodes) {
    g.setNode(n.id, { width: n.width, height: n.height })
    if (n.group) g.setParent(n.id, `__group__${n.group}`)
  }

  let index = 0
  for (const e of edges) {
    if (!g.hasNode(e.source) || !g.hasNode(e.target)) continue
    if (e.source === e.target) continue
    g.setEdge(e.source, e.target, {}, `e${index++}`)
  }

  dagre.layout(g)

  const result: LayoutResult = {}
  for (const n of nodes) {
    const laid = g.node(n.id) as { x?: number; y?: number } | undefined
    if (laid && typeof laid.x === 'number' && typeof laid.y === 'number') {
      result[n.id] = { x: laid.x, y: laid.y }
    }
  }
  post(result)
}
