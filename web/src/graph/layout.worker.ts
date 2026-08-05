/// <reference lib="webworker" />
import Graph from 'graphology'
import forceAtlas2 from 'graphology-layout-forceatlas2'

// ForceAtlas2 on a few thousand nodes blocks for seconds. Running it here keeps
// panning and zooming responsive while a layout settles, which is the difference
// between a graph that feels alive and one that appears frozen.

export interface LayoutRequest {
  nodes: { id: string; size: number }[]
  edges: { source: string; target: string }[]
}

export type LayoutResult = Record<string, { x: number; y: number }>

/**
 * Seeds positions on a circle rather than at random.
 *
 * Random seeding makes an unchanged cluster settle into a different shape on
 * every reload, which reads as the graph having changed when it has not. A
 * deterministic seed means the same input always produces the same picture.
 */
function seed(index: number, total: number): { x: number; y: number } {
  const angle = (2 * Math.PI * index) / Math.max(total, 1)
  const radius = 10 + total * 0.12
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const { nodes, edges } = event.data

  const graph = new Graph({ multi: false, type: 'directed' })
  nodes.forEach((n, i) => graph.addNode(n.id, { ...seed(i, nodes.length), size: n.size }))
  for (const e of edges) {
    if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue
    if (e.source === e.target || graph.hasEdge(e.source, e.target)) continue
    graph.addDirectedEdge(e.source, e.target)
  }

  if (graph.order === 0) {
    ;(self as unknown as Worker).postMessage({} satisfies LayoutResult)
    return
  }

  const inferred = forceAtlas2.inferSettings(graph)
  const positions = forceAtlas2(graph, {
    // Enough to settle without making a large cluster wait; the layout is
    // recomputed on every graph change, so perfection here is wasted.
    iterations: graph.order > 600 ? 120 : 320,
    getEdgeWeight: null,
    settings: {
      ...inferred,
      // Honour node size so big namespace nodes do not swallow their neighbours.
      adjustSizes: true,
      barnesHutOptimize: graph.order > 200,
      gravity: 1.2,
      scalingRatio: 24,
      slowDown: 4,
    },
  })

  ;(self as unknown as Worker).postMessage(positions as LayoutResult)
}
