import { useEffect, useRef } from 'react'
import Graph from 'graphology'
import Sigma from 'sigma'
import { createNodeCompoundProgram } from 'sigma/rendering'
import { createNodeBorderProgram } from '@sigma/node-border'
import { createNodeImageProgram } from '@sigma/node-image'
import EdgeCurveProgram from '@sigma/edge-curve'

import type { Graph as GraphData, GraphEdge, GraphNode } from '../api'
import { iconFor } from './icons'
import {
  cssVar,
  dimmed,
  edgeColor,
  edgeLabel,
  edgeSize,
  isUnprotected,
  nodeBorderColor,
  nodeColor,
  nodeSize,
  type NamespacePalette,
} from './style'
import type { LayoutRequest, LayoutResult } from './layout.worker'

// A node is a ring plus a pictogram: the ring carries the namespace accent — or
// red when nothing protects the workload — and the pictogram says what kind of
// thing it is. Together they let someone read the graph's shape without reading
// a single label, which is the only way a large graph is legible at all.
const NodeRing = createNodeBorderProgram({
  borders: [
    { size: { value: 0.16 }, color: { attribute: 'borderColor' } },
    { size: { fill: true }, color: { attribute: 'color' } },
  ],
})

// keepWithinCircle would have the program paint its own disc, which in a
// compound covers the ring and fill underneath and leaves a flat dark blob.
const NodePictogram = createNodeImageProgram({
  padding: 0.36,
  size: { mode: 'force', value: 256 },
  drawingMode: 'color',
  colorAttribute: 'pictoColor',
  keepWithinCircle: false,
})

const NodeProgram = createNodeCompoundProgram([NodeRing, NodePictogram])

interface Props {
  data: GraphData
  palette: NamespacePalette
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
 * cluster with thousands of elements pannable at all — an SVG element per pod
 * stops being interactive in the low thousands.
 */
export function GraphView({
  data,
  palette,
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

  // Created once and reused: rebuilding the renderer would throw away the
  // camera, which is the one piece of state the user has invested effort in.
  useEffect(() => {
    if (!container.current) return

    const renderer = new Sigma(graph.current, container.current, {
      defaultNodeType: 'bordered-pictogram',
      nodeProgramClasses: { 'bordered-pictogram': NodeProgram },
      // Curved edges: with several allowances between the same pair, straight
      // lines stack into one indistinguishable stroke.
      defaultEdgeType: 'curved',
      edgeProgramClasses: { curved: EdgeCurveProgram },
      renderEdgeLabels: true,
      labelDensity: 0.8,
      labelGridCellSize: 64,
      labelRenderedSizeThreshold: 6,
      labelFont: 'ui-sans-serif, system-ui, sans-serif',
      labelSize: 12,
      labelWeight: '500',
      labelColor: { attribute: 'labelColor' },
      edgeLabelColor: { attribute: 'color' },
      edgeLabelFont: 'ui-monospace, SFMono-Regular, monospace',
      edgeLabelSize: 10.5,
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
    // between being able to follow a node's edges and not.
    renderer.on('enterNode', ({ node }) => {
      hovered.current = node
      container.current?.style.setProperty('cursor', 'pointer')
      renderer.refresh({ skipIndexation: true })
    })
    renderer.on('leaveNode', () => {
      hovered.current = null
      container.current?.style.setProperty('cursor', 'default')
      renderer.refresh({ skipIndexation: true })
    })

    return () => {
      renderer.kill()
      sigma.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reducers read the refs above, so they see the current hover and selection
  // without the renderer being rebuilt.
  useEffect(() => {
    const renderer = sigma.current
    if (!renderer) return
    const light = theme === 'light'

    renderer.setSetting('nodeReducer', (key, attrs) => {
      const res = { ...attrs } as Record<string, unknown>
      const active = hovered.current

      if (key === selectedId) {
        res.highlighted = true
        res.borderColor = cssVar('--accent')
        res.zIndex = 3
      }
      if (active) {
        const related = key === active || graph.current.neighbors(active).includes(key)
        if (!related) {
          res.color = dimmed(light)
          res.borderColor = dimmed(light)
          res.pictoColor = 'rgba(0,0,0,0)'
          res.label = ''
          res.zIndex = 0
        } else {
          res.zIndex = 2
        }
      }
      return res
    })

    renderer.setSetting('edgeReducer', (key, attrs) => {
      const res = { ...attrs } as Record<string, unknown>
      const active = hovered.current

      if (key === selectedId) {
        res.color = cssVar('--accent')
        res.size = 4
        res.zIndex = 3
      }
      if (active) {
        const [source, target] = graph.current.extremities(key)
        if (source !== active && target !== active) {
          res.color = dimmed(light)
          res.label = ''
          res.zIndex = 0
        } else {
          res.zIndex = 2
        }
      }
      return res
    })

    renderer.refresh({ skipIndexation: true })
  }, [selectedId, theme])

  // Rebuild on data change, preserving positions for surviving nodes so a live
  // update nudges the picture rather than reshuffling it.
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
        color: nodeColor(node, palette),
        borderColor: nodeBorderColor(node, palette),
        image: iconFor(node.kind, node.workloadKind),
        pictoColor: cssVar('--picto'),
        labelColor: cssVar('--text'),
        x: at?.x ?? 0,
        y: at?.y ?? 0,
        kind: node.kind,
        // Unprotected nodes sit above the rest, so a red ring is never buried
        // under a neighbour.
        zIndex: isUnprotected(node) ? 1 : 0,
      })
    }

    for (const edge of data.edges) {
      if (!g.hasNode(edge.source) || !g.hasNode(edge.target)) continue
      g.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, {
        size: edgeSize(edge),
        color: edgeColor(edge),
        label: edgeLabel(edge),
        kind: edge.kind,
        // Curvature scales with how many allowances share the pair, so parallel
        // edges fan out instead of overlapping.
        curvature: 0.25,
      })
    }

    worker.current?.terminate()
    const w = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' })
    worker.current = w

    w.onmessage = (event: MessageEvent<LayoutResult>) => {
      for (const [id, pos] of Object.entries(event.data)) {
        if (!g.hasNode(id)) continue
        g.setNodeAttribute(id, 'x', pos.x)
        g.setNodeAttribute(id, 'y', pos.y)
      }
      sigma.current?.refresh()
      sigma.current?.getCamera().animatedReset({ duration: 300 })
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
  }, [data, palette])

  // Repaint on theme change without disturbing the layout.
  useEffect(() => {
    const g = graph.current
    g.forEachNode((id) => {
      const node = nodeIndex.current.get(id)
      if (!node) return
      g.setNodeAttribute(id, 'color', nodeColor(node, palette))
      g.setNodeAttribute(id, 'borderColor', nodeBorderColor(node, palette))
      g.setNodeAttribute(id, 'pictoColor', cssVar('--picto'))
      g.setNodeAttribute(id, 'labelColor', cssVar('--text'))
    })
    g.forEachEdge((id) => {
      const edge = edgeIndex.current.get(id)
      if (edge) g.setEdgeAttribute(id, 'color', edgeColor(edge))
    })
    sigma.current?.refresh()
  }, [theme, palette])

  // Search jumps the camera. The camera works in display coordinates, so the
  // position has to come from the renderer rather than the graph.
  useEffect(() => {
    const renderer = sigma.current
    if (!focusId || !renderer || !graph.current.hasNode(focusId)) return
    const display = renderer.getNodeDisplayData(focusId)
    if (!display) return
    renderer.getCamera().animate({ x: display.x, y: display.y, ratio: 0.4 }, { duration: 420 })
  }, [focusId])

  return <div className="canvas" ref={container} />
}
