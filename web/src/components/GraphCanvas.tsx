import { useEffect, useRef } from 'react'
import Graph from 'graphology'
import Sigma from 'sigma'
import { createNodeCompoundProgram } from 'sigma/rendering'
import { createNodeBorderProgram } from '@sigma/node-border'
import { createNodeImageProgram } from '@sigma/node-image'
import { EdgeCurvedArrowProgram } from '@sigma/edge-curve'

import type { Graph as GraphData, GraphEdge, GraphNode } from '../api'
import { iconFor } from '../graph/icons'
import { FlowRenderer, type FlowEdge } from '../graph/flow'
import {
  dimmedEdge,
  dimmedFill,
  dimmedRing,
  edgeColor,
  edgeLabel,
  edgeSize,
  isUnprotected,
  nodeBorderColor,
  nodeColor,
  nodeSize,
  paint,
  type NamespacePalette,
} from '../graph/style'
import type { LayoutRequest, LayoutResult } from '../graph/layout.worker'

// A node is a ring plus a pictogram: the ring carries the namespace colour — or
// red when nothing protects the workload — and the pictogram says what kind of
// thing it is. Together they let someone read a cluster's shape without reading
// a single label, which is the only way a large graph is legible.
const NodeRing = createNodeBorderProgram({
  borders: [
    { size: { value: 0.16 }, color: { attribute: 'borderColor' } },
    { size: { fill: true }, color: { attribute: 'color' } },
  ],
})

// Icons are drawn as tinted masks so the disc keeps its namespace colour and
// the ring keeps its warning. keepWithinCircle stays off: it would have the
// program paint its own disc over both.
const NodePictogram = createNodeImageProgram({
  padding: 0.38,
  size: { mode: 'force', value: 256 },
  drawingMode: 'color',
  colorAttribute: 'pictoColor',
  keepWithinCircle: false,
})

const NodeProgram = createNodeCompoundProgram([NodeRing, NodePictogram])

const CURVATURE = 0.22

/**
 * Sigma's built-in hover renderer paints a white label plate, which on a dark
 * canvas reads as a rendering artefact rather than as emphasis. This draws the
 * same information in the app's own palette.
 */
function drawNodeHover(
  ctx: CanvasRenderingContext2D,
  data: { x: number; y: number; size: number; label?: string | null },
  settings: { labelSize: number; labelFont: string; labelWeight: string },
) {
  const label = data.label
  if (!label) return

  ctx.font = `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`
  const padX = 8
  const height = settings.labelSize + 10
  const width = ctx.measureText(label).width + padX * 2
  const x = data.x + data.size + 6
  const y = data.y - height / 2
  const radius = height / 2

  ctx.beginPath()
  ctx.roundRect(x, y, width, height, radius)
  ctx.fillStyle = paint('plate')
  ctx.fill()
  ctx.strokeStyle = paint('plateEdge')
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.fillStyle = paint('fg')
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x + padX, data.y)
}

interface Props {
  data: GraphData
  palette: NamespacePalette
  theme: 'dark' | 'light'
  animateFlow: boolean
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
export function GraphCanvas({
  data,
  palette,
  theme,
  animateFlow,
  selectedId,
  focusId,
  onSelectNode,
  onSelectEdge,
  onClearSelection,
}: Props) {
  const container = useRef<HTMLDivElement>(null)
  const overlay = useRef<HTMLCanvasElement>(null)
  const sigma = useRef<Sigma | null>(null)
  const flow = useRef<FlowRenderer | null>(null)
  const graph = useRef<Graph>(new Graph({ multi: true, type: 'directed' }))
  const worker = useRef<Worker | null>(null)
  const nodeIndex = useRef<Map<string, GraphNode>>(new Map())
  const edgeIndex = useRef<Map<string, GraphEdge>>(new Map())
  const hovered = useRef<string | null>(null)

  // Created once and reused: rebuilding the renderer throws away the camera,
  // which is the one piece of state the user has invested effort in.
  useEffect(() => {
    if (!container.current || !overlay.current) return

    const renderer = new Sigma(graph.current, container.current, {
      defaultNodeType: 'bordered-pictogram',
      nodeProgramClasses: { 'bordered-pictogram': NodeProgram },
      // Curved edges with arrowheads: direction is half the meaning of a policy
      // graph, and several allowances between one pair need to fan out rather
      // than stack into a single indistinguishable stroke.
      defaultEdgeType: 'curved',
      edgeProgramClasses: { curved: EdgeCurvedArrowProgram },
      renderEdgeLabels: true,
      labelDensity: 0.9,
      labelGridCellSize: 62,
      labelRenderedSizeThreshold: 6,
      labelFont: "'Inter var', ui-sans-serif, system-ui, sans-serif",
      labelSize: 12,
      labelWeight: '500',
      labelColor: { attribute: 'labelColor' },
      edgeLabelColor: { attribute: 'color' },
      edgeLabelFont: 'ui-monospace, SFMono-Regular, monospace',
      edgeLabelSize: 10.5,
      defaultDrawNodeHover: drawNodeHover,
      zIndex: true,
      minCameraRatio: 0.05,
      maxCameraRatio: 12,
    })
    sigma.current = renderer

    const flowRenderer = new FlowRenderer(overlay.current, renderer)
    flow.current = flowRenderer
    flowRenderer.resize()

    renderer.on('afterRender', () => flowRenderer.resize())
    renderer.on('clickNode', ({ node }) => {
      const found = nodeIndex.current.get(node)
      if (found) onSelectNode(found)
    })
    renderer.on('clickEdge', ({ edge }) => {
      const found = edgeIndex.current.get(edge)
      if (found) onSelectEdge(found)
    })
    renderer.on('clickStage', () => onClearSelection())

    // Hover dims everything unrelated and narrows the animation to what this
    // node can reach. On a dense graph that is the difference between being able
    // to follow a node's edges and not.
    renderer.on('enterNode', ({ node }) => {
      hovered.current = node
      container.current?.style.setProperty('cursor', 'pointer')
      const related = new Set<string>()
      graph.current.forEachEdge(node, (edgeKey) => related.add(edgeKey))
      flowRenderer.setHighlight(related)
      renderer.refresh({ skipIndexation: true })
    })
    renderer.on('leaveNode', () => {
      hovered.current = null
      container.current?.style.setProperty('cursor', 'default')
      flowRenderer.setHighlight(null)
      renderer.refresh({ skipIndexation: true })
    })

    return () => {
      flowRenderer.stop()
      renderer.kill()
      sigma.current = null
      flow.current = null
    }
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

      // Deliberately not `highlighted: true`: Sigma renders that as a white
      // label plate, which on a dark canvas reads as a rendering artefact.
      // Selection is shown by the ring instead.
      if (key === selectedId) {
        res.borderColor = paint('accent')
        res.zIndex = 3
      }
      if (active) {
        const related = key === active || graph.current.neighbors(active).includes(key)
        if (!related) {
          // Contrast is drained but the shape and icon stay: a hover that turns
          // the rest of the graph into featureless blobs is worse than none.
          res.color = dimmedFill()
          res.borderColor = dimmedRing()
          res.pictoColor = dimmedRing()
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
        res.color = paint('accent')
        res.size = 4
        res.zIndex = 3
      }
      if (active) {
        const [source, target] = graph.current.extremities(key)
        if (source !== active && target !== active) {
          res.color = dimmedEdge()
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
        pictoColor: paint('picto'),
        labelColor: paint('fg'),
        x: at?.x ?? 0,
        y: at?.y ?? 0,
        kind: node.kind,
        zIndex: isUnprotected(node) ? 1 : 0,
      })
    }

    const flowEdges: FlowEdge[] = []
    for (const edge of data.edges) {
      if (!g.hasNode(edge.source) || !g.hasNode(edge.target)) continue
      g.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, {
        size: edgeSize(edge),
        color: edgeColor(edge),
        label: edgeLabel(edge),
        kind: edge.kind,
        curvature: CURVATURE,
      })
      flowEdges.push({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
        curvature: CURVATURE,
      })
    }
    flow.current?.setEdges(flowEdges)

    worker.current?.terminate()
    const w = new Worker(new URL('../graph/layout.worker.ts', import.meta.url), { type: 'module' })
    worker.current = w

    w.onmessage = (event: MessageEvent<LayoutResult>) => {
      for (const [id, pos] of Object.entries(event.data)) {
        if (!g.hasNode(id)) continue
        g.setNodeAttribute(id, 'x', pos.x)
        g.setNodeAttribute(id, 'y', pos.y)
      }
      sigma.current?.refresh()
      sigma.current?.getCamera().animatedReset({ duration: 320 })
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
      g.setNodeAttribute(id, 'pictoColor', paint('picto'))
      g.setNodeAttribute(id, 'labelColor', paint('fg'))
    })
    g.forEachEdge((id) => {
      const edge = edgeIndex.current.get(id)
      if (edge) g.setEdgeAttribute(id, 'color', edgeColor(edge))
    })
    sigma.current?.refresh()
  }, [theme, palette])

  useEffect(() => {
    const f = flow.current
    if (!f) return
    if (animateFlow) f.start_()
    else f.stop()
  }, [animateFlow, data])

  // Search jumps the camera. The camera works in display coordinates, so the
  // position comes from the renderer rather than the graph.
  useEffect(() => {
    const renderer = sigma.current
    if (!focusId || !renderer || !graph.current.hasNode(focusId)) return
    const display = renderer.getNodeDisplayData(focusId)
    if (!display) return
    renderer.getCamera().animate({ x: display.x, y: display.y, ratio: 0.4 }, { duration: 420 })
  }, [focusId])

  return (
    <>
      <div className="absolute inset-0" ref={container} />
      {/* Above the WebGL canvas but transparent to input, so the animation never
          intercepts a click meant for a node. */}
      <canvas className="pointer-events-none absolute inset-0" ref={overlay} />
    </>
  )
}
