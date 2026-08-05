import { useEffect, useRef } from 'react'
import Graph from 'graphology'
import Sigma from 'sigma'

import type { Graph as GraphData, GraphEdge, GraphNode } from '../api'
import { cssVar, edgeColor, edgeLabel, edgeSize, isUnprotected, nodeColor, nodeSize } from './style'
import type { LayoutRequest, LayoutResult } from './layout.worker'

interface Props {
  data: GraphData
  theme: 'dark' | 'light'
  selectedId: string | null
  focusId: string | null
  onSelectNode: (node: GraphNode) => void
  onSelectEdge: (edge: GraphEdge) => void
  onClearSelection: () => void
}

/**
 * WebGL graph canvas.
 *
 * Sigma renders on the GPU rather than as SVG DOM nodes, which is what makes a
 * cluster with thousands of elements pannable at all — an SVG node per pod stops
 * being interactive in the low thousands.
 */
export function GraphView({
  data,
  theme,
  selectedId,
  focusId,
  onSelectNode,
  onSelectEdge,
  onClearSelection,
}: Props) {
  const container = useRef<HTMLDivElement>(null)
  const sigma = useRef<Sigma | null>(null)
  const graph = useRef<Graph>(new Graph({ multi: true, type: 'directed' }))
  const worker = useRef<Worker | null>(null)
  const nodeIndex = useRef<Map<string, GraphNode>>(new Map())
  const edgeIndex = useRef<Map<string, GraphEdge>>(new Map())
  const hovered = useRef<string | null>(null)

  // Sigma instance: created once and reused. Recreating it on every data change
  // would throw away camera position, which is the one piece of state the user
  // has invested effort in.
  useEffect(() => {
    if (!container.current) return

    const renderer = new Sigma(graph.current, container.current, {
      renderEdgeLabels: true,
      defaultEdgeType: 'arrow',
      labelDensity: 0.6,
      labelGridCellSize: 70,
      labelRenderedSizeThreshold: 7,
      zIndex: true,
      minCameraRatio: 0.05,
      maxCameraRatio: 12,
    })
    sigma.current = renderer

    renderer.on('clickNode', ({ node }) => {
      const found = nodeIndex.current.get(node)
      if (found) onSelectNode(found)
    })
    renderer.on('clickEdge', ({ edge }) => {
      const found = edgeIndex.current.get(edge)
      if (found) onSelectEdge(found)
    })
    renderer.on('clickStage', () => onClearSelection())

    // Hover dims everything unrelated. On a dense graph this is the difference
    // between "I can see this node's edges" and "I cannot".
    renderer.on('enterNode', ({ node }) => {
      hovered.current = node
      renderer.refresh({ skipIndexation: true })
    })
    renderer.on('leaveNode', () => {
      hovered.current = null
      renderer.refresh({ skipIndexation: true })
    })

    return () => {
      renderer.kill()
      sigma.current = null
    }
    // The callbacks are stable for the lifetime of the parent; re-running this
    // effect would destroy the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reducers read the refs above, so they see the current hover and selection
  // without the renderer being rebuilt.
  useEffect(() => {
    const renderer = sigma.current
    if (!renderer) return

    renderer.setSetting('nodeReducer', (key, attrs) => {
      const res = { ...attrs } as Record<string, unknown>
      const active = hovered.current
      if (key === selectedId) {
        res.highlighted = true
        res.zIndex = 2
      }
      if (active) {
        const related =
          key === active || graph.current.neighbors(active).includes(key)
        if (!related) {
          res.color = 'rgba(120,130,145,0.18)'
          res.label = ''
          res.zIndex = 0
        }
      }
      return res
    })

    renderer.setSetting('edgeReducer', (key, attrs) => {
      const res = { ...attrs } as Record<string, unknown>
      const active = hovered.current
      if (key === selectedId) {
        res.color = cssVar('--accent')
        res.size = 3.5
        res.zIndex = 2
      }
      if (active) {
        const [source, target] = graph.current.extremities(key)
        if (source !== active && target !== active) {
          res.color = 'rgba(120,130,145,0.10)'
          res.label = ''
          res.zIndex = 0
        }
      }
      return res
    })

    renderer.refresh({ skipIndexation: true })
  }, [selectedId, theme])

  // Rebuild the graph when data changes, preserving positions for nodes that
  // survived so a live update nudges the picture rather than reshuffling it.
  useEffect(() => {
    const g = graph.current
    const previous = new Map<string, { x: number; y: number }>()
    g.forEachNode((id, attrs) => previous.set(id, { x: attrs.x as number, y: attrs.y as number }))

    g.clear()
    nodeIndex.current = new Map(data.nodes.map((n) => [n.id, n]))
    edgeIndex.current = new Map(data.edges.map((e) => [e.id, e]))

    for (const node of data.nodes) {
      const at = previous.get(node.id)

      g.addNode(node.id, {
        label: node.label,
        size: nodeSize(node),
        // An unprotected node is drawn in the danger colour outright. It is the
        // one thing a viewer should be able to spot without reading a label.
        color: isUnprotected(node) ? cssVar('--danger') : nodeColor(node),
        x: at?.x ?? 0,
        y: at?.y ?? 0,
        kind: node.kind,
      })
    }

    for (const edge of data.edges) {
      if (!g.hasNode(edge.source) || !g.hasNode(edge.target)) continue
      g.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, {
        size: edgeSize(edge),
        color: edgeColor(edge),
        label: edgeLabel(edge),
        kind: edge.kind,
      })
    }

    // Layout off the main thread. A stale result arriving after the next update
    // is discarded by checking that every node still exists.
    worker.current?.terminate()
    const w = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' })
    worker.current = w

    w.onmessage = (event: MessageEvent<LayoutResult>) => {
      const positions = event.data
      for (const [id, pos] of Object.entries(positions)) {
        if (!g.hasNode(id)) continue
        g.setNodeAttribute(id, 'x', pos.x)
        g.setNodeAttribute(id, 'y', pos.y)
      }
      sigma.current?.refresh()
      sigma.current?.getCamera().animatedReset({ duration: 240 })
    }

    const request: LayoutRequest = {
      nodes: data.nodes.map((n) => ({ id: n.id, size: nodeSize(n) })),
      edges: data.edges.map((e) => ({ source: e.source, target: e.target })),
    }
    w.postMessage(request)

    return () => {
      w.terminate()
      if (worker.current === w) worker.current = null
    }
  }, [data])

  // Recolour on theme change without touching layout.
  useEffect(() => {
    const g = graph.current
    g.forEachNode((id) => {
      const node = nodeIndex.current.get(id)
      if (node) g.setNodeAttribute(id, 'color', nodeColor(node))
    })
    g.forEachEdge((id) => {
      const edge = edgeIndex.current.get(id)
      if (edge) g.setEdgeAttribute(id, 'color', edgeColor(edge))
    })
    sigma.current?.refresh()
  }, [theme])

  // Search jumps the camera to a node. The camera works in display coordinates,
  // not graph coordinates, so the position has to come from the renderer.
  useEffect(() => {
    const renderer = sigma.current
    if (!focusId || !renderer || !graph.current.hasNode(focusId)) return
    const display = renderer.getNodeDisplayData(focusId)
    if (!display) return
    renderer.getCamera().animate({ x: display.x, y: display.y, ratio: 0.35 }, { duration: 420 })
  }, [focusId])

  return <div className="canvas" ref={container} />
}
