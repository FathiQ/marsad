import { useEffect, useRef } from 'react'
import Graph from 'graphology'
import Sigma from 'sigma'
import { EdgeCurvedArrowProgram } from '@sigma/edge-curve'

import type { Graph as GraphData, GraphEdge, GraphNode } from '../api'
import { OverlayRenderer } from '../graph/overlay'
import {
  dimmedEdge,
  edgeColor,
  edgeSize,
  nodeSize,
  paint,
  type NamespacePalette,
} from '../graph/style'
import type { LayoutRequest, LayoutResult } from '../graph/layout.worker'

const CURVATURE = 0.22

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
 * The graph canvas.
 *
 * Sigma owns the camera, the edges and edge hit-testing; it renders on the GPU,
 * which is what keeps a cluster with thousands of elements pannable at all.
 * Nodes are drawn by the overlay instead, as cards — see graph/overlay.ts for
 * why. Sigma's own nodes stay in place but transparent, so edges still converge
 * on the right point and the layout still has vertices to arrange.
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
  const canvas = useRef<HTMLCanvasElement>(null)
  const sigma = useRef<Sigma | null>(null)
  const overlay = useRef<OverlayRenderer | null>(null)
  const graph = useRef<Graph>(new Graph({ multi: true, type: 'directed' }))
  const worker = useRef<Worker | null>(null)
  const nodeIndex = useRef<Map<string, GraphNode>>(new Map())
  const edgeIndex = useRef<Map<string, GraphEdge>>(new Map())
  const hovered = useRef<string | null>(null)

  useEffect(() => {
    if (!container.current || !canvas.current) return

    const renderer = new Sigma(graph.current, container.current, {
      // Nodes are invisible here and drawn as cards by the overlay; Sigma keeps
      // them so edges have endpoints and the layout has vertices.
      defaultNodeColor: 'rgba(0,0,0,0)',
      // All text is drawn by the overlay: node names inside the cards, port
      // labels on the edge midpoints. Sigma ties edge-label visibility to
      // node-label visibility, which this design has none of, so the whole label
      // layer is off rather than fought with.
      renderLabels: false,
      renderEdgeLabels: false,
      defaultDrawNodeHover: () => {},
      // Direction is half the meaning of a policy graph, and several allowances
      // between one pair must fan out rather than stack into one stroke.
      defaultEdgeType: 'curved',
      edgeProgramClasses: { curved: EdgeCurvedArrowProgram },
      enableEdgeEvents: true,
      zIndex: true,
      minCameraRatio: 0.05,
      maxCameraRatio: 12,
    })
    sigma.current = renderer

    const over = new OverlayRenderer(canvas.current, renderer)
    overlay.current = over
    over.resize()
    over.start()

    renderer.on('afterRender', () => over.resize())
    renderer.on('clickEdge', ({ edge }) => {
      const found = edgeIndex.current.get(edge)
      if (found) onSelectEdge(found)
    })

    // Node interaction lives here rather than in Sigma: a card is a rectangle,
    // and Sigma's hit-testing assumes a circle.
    const element = container.current
    const localPoint = (event: MouseEvent) => {
      const rect = element.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }

    const onMove = (event: MouseEvent) => {
      const { x, y } = localPoint(event)
      const hit = over.hitTest(x, y)
      if (hit === hovered.current) return
      hovered.current = hit
      over.setHovered(hit)
      element.style.cursor = hit ? 'pointer' : 'default'
      renderer.refresh({ skipIndexation: true })
    }

    const onLeave = () => {
      hovered.current = null
      over.setHovered(null)
      renderer.refresh({ skipIndexation: true })
    }

    let downAt: { x: number; y: number } | null = null
    const onDown = (event: MouseEvent) => {
      downAt = localPoint(event)
    }
    const onUp = (event: MouseEvent) => {
      const { x, y } = localPoint(event)
      // Only a click, not the end of a pan: dragging the stage must not select.
      if (!downAt || Math.hypot(x - downAt.x, y - downAt.y) > 4) {
        downAt = null
        return
      }
      downAt = null
      const hit = over.hitTest(x, y)
      if (hit) {
        const found = nodeIndex.current.get(hit)
        if (found) onSelectNode(found)
      } else {
        onClearSelection()
      }
    }

    element.addEventListener('mousemove', onMove)
    element.addEventListener('mouseleave', onLeave)
    element.addEventListener('mousedown', onDown)
    element.addEventListener('mouseup', onUp)

    return () => {
      element.removeEventListener('mousemove', onMove)
      element.removeEventListener('mouseleave', onLeave)
      element.removeEventListener('mousedown', onDown)
      element.removeEventListener('mouseup', onUp)
      over.stop()
      renderer.kill()
      sigma.current = null
      overlay.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Edges dim around a hovered node so its neighbourhood can be followed.
  useEffect(() => {
    const renderer = sigma.current
    if (!renderer) return

    renderer.setSetting('edgeReducer', (key, attrs) => {
      const res = { ...attrs } as Record<string, unknown>
      if (key === selectedId) {
        res.color = paint('accent')
        res.size = 4
        res.zIndex = 3
      }
      const active = hovered.current
      if (active) {
        const [source, target] = graph.current.extremities(key)
        if (source !== active && target !== active) {
          res.color = dimmedEdge()
          res.zIndex = 0
        } else {
          res.zIndex = 2
        }
      }
      return res
    })
    renderer.refresh({ skipIndexation: true })
  }, [selectedId, theme])

  useEffect(() => {
    overlay.current?.setSelected(selectedId)
  }, [selectedId])

  useEffect(() => {
    overlay.current?.setAnimate(animateFlow)
  }, [animateFlow])

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
        size: nodeSize(node),
        color: 'rgba(0,0,0,0)',
        x: at?.x ?? 0,
        y: at?.y ?? 0,
      })
    }

    for (const edge of data.edges) {
      if (!g.hasNode(edge.source) || !g.hasNode(edge.target)) continue
      g.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, {
        size: edgeSize(edge),
        color: edgeColor(edge),
        curvature: CURVATURE,
      })
    }

    overlay.current?.setData(data, palette)

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

    w.postMessage({
      nodes: data.nodes.map((n) => ({ id: n.id, size: nodeSize(n) })),
      edges: data.edges.map((e) => ({ source: e.source, target: e.target })),
    } satisfies LayoutRequest)

    return () => {
      w.terminate()
      if (worker.current === w) worker.current = null
    }
  }, [data, palette])

  useEffect(() => {
    const g = graph.current
    g.forEachEdge((id) => {
      const edge = edgeIndex.current.get(id)
      if (edge) g.setEdgeAttribute(id, 'color', edgeColor(edge))
    })
    overlay.current?.setData(data, palette)
    sigma.current?.refresh()
  }, [theme, data, palette])

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
      {/* Above Sigma's canvases and transparent to input: hit-testing runs
          against the card rectangles, on the container beneath. */}
      <canvas className="pointer-events-none absolute inset-0" ref={canvas} />
    </>
  )
}
