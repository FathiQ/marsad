import { useEffect, useRef } from 'react'
import Graph from 'graphology'
import Sigma from 'sigma'

import type { Graph as GraphData, GraphEdge, GraphNode } from '../api'
import { OverlayRenderer } from '../graph/overlay'
import type { NamespacePalette } from '../graph/style'
import type { LayoutResult } from '../graph/layout.worker'

interface Props {
  data: GraphData
  palette: NamespacePalette
  theme: 'dark' | 'light'
  animateFlow: boolean
  showGroups: boolean
  selectedId: string | null
  focusId: string | null
  onSelectNode: (node: GraphNode) => void
  onSelectEdge: (edge: GraphEdge) => void
  onClearSelection: () => void
}

/**
 * The graph canvas.
 *
 * Sigma is used for what it is genuinely good at — the camera, the coordinate
 * space, and inertial pan and zoom that stay smooth on a large graph. Everything
 * visible is drawn by the overlay, because cards, namespace containers and edges
 * that terminate on a specific port are not things a node-and-line renderer has
 * any concept of. Sigma's own nodes are kept, sized to nothing and transparent,
 * purely to hold positions.
 */
export function GraphCanvas({
  data,
  palette,
  theme,
  animateFlow,
  showGroups,
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
  const graph = useRef<Graph>(new Graph({ type: 'directed' }))
  const worker = useRef<Worker | null>(null)
  const nodeIndex = useRef<Map<string, GraphNode>>(new Map())
  const edgeIndex = useRef<Map<string, GraphEdge>>(new Map())
  const hovered = useRef<string | null>(null)

  useEffect(() => {
    if (!container.current || !canvas.current) return

    const renderer = new Sigma(graph.current, container.current, {
      defaultNodeColor: 'rgba(0,0,0,0)',
      renderLabels: false,
      renderEdgeLabels: false,
      defaultDrawNodeHover: () => {},
      minCameraRatio: 0.06,
      maxCameraRatio: 4,
    })
    sigma.current = renderer

    const over = new OverlayRenderer(canvas.current, renderer)
    overlay.current = over
    over.resize()
    over.start()

    renderer.on('afterRender', () => over.resize())

    const element = container.current
    const localPoint = (event: MouseEvent) => {
      const rect = element.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }

    const onMove = (event: MouseEvent) => {
      const { x, y } = localPoint(event)
      const hit = over.hitTest(x, y)
      if (hit !== hovered.current) {
        hovered.current = hit
        over.setHovered(hit)
      }
      element.style.cursor = hit || over.hitTestEdge(x, y) ? 'pointer' : 'default'
    }

    const onLeave = () => {
      hovered.current = null
      over.setHovered(null)
    }

    let downAt: { x: number; y: number } | null = null
    const onDown = (event: MouseEvent) => {
      downAt = localPoint(event)
    }
    const onUp = (event: MouseEvent) => {
      const { x, y } = localPoint(event)
      // A click, not the end of a pan: dragging the stage must not select.
      if (!downAt || Math.hypot(x - downAt.x, y - downAt.y) > 4) {
        downAt = null
        return
      }
      downAt = null

      const node = over.hitTest(x, y)
      if (node) {
        const found = nodeIndex.current.get(node)
        if (found) onSelectNode(found)
        return
      }
      const edge = over.hitTestEdge(x, y)
      if (edge) {
        const found = edgeIndex.current.get(edge)
        if (found) onSelectEdge(found)
        return
      }
      onClearSelection()
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

  useEffect(() => {
    overlay.current?.setSelected(selectedId)
  }, [selectedId])

  useEffect(() => {
    overlay.current?.setAnimate(animateFlow)
  }, [animateFlow])

  useEffect(() => {
    overlay.current?.setGroupsVisible(showGroups)
  }, [showGroups])

  // Rebuild on data or theme change. Theme is a dependency because the card
  // colours are resolved at build time, not per frame.
  useEffect(() => {
    const over = overlay.current
    const g = graph.current
    if (!over) return

    const previous = new Map<string, { x: number; y: number }>()
    g.forEachNode((id, attrs) => previous.set(id, { x: attrs.x as number, y: attrs.y as number }))

    nodeIndex.current = new Map(data.nodes.map((n) => [n.id, n]))
    edgeIndex.current = new Map(data.edges.map((e) => [e.id, e]))
    over.setData(data, palette)

    g.clear()
    for (const node of data.nodes) {
      const at = previous.get(node.id)
      g.addNode(node.id, { size: 1, color: 'rgba(0,0,0,0)', x: at?.x ?? 0, y: at?.y ?? 0 })
    }

    worker.current?.terminate()
    const w = new Worker(new URL('../graph/layout.worker.ts', import.meta.url), { type: 'module' })
    worker.current = w

    w.onmessage = (event: MessageEvent<LayoutResult>) => {
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity

      for (const [id, pos] of Object.entries(event.data)) {
        if (!g.hasNode(id)) continue
        g.setNodeAttribute(id, 'x', pos.x)
        // Screen y grows downward while graph y grows upward, so a layered
        // layout comes out mirrored unless it is flipped here.
        g.setNodeAttribute(id, 'y', -pos.y)
        minX = Math.min(minX, pos.x)
        maxX = Math.max(maxX, pos.x)
        minY = Math.min(minY, -pos.y)
        maxY = Math.max(maxY, -pos.y)
      }

      const renderer = sigma.current
      if (!renderer) return
      renderer.refresh()

      // Fit to what is drawn, not to where the nodes are. Sigma frames the node
      // *positions*, which for card nodes leaves half a card hanging off each
      // edge of the viewport — the wider the cards, the worse it looks.
      const spanX = maxX - minX
      const spanY = maxY - minY
      const card = over.extent()
      const ratio =
        Number.isFinite(spanX) && spanX > 0 && spanY > 0
          ? Math.max(
              (spanX + card.width) / spanX,
              (spanY + card.height) / spanY,
              1,
            ) * 1.06
          : 1.2

      renderer.getCamera().animate({ x: 0.5, y: 0.5, ratio }, { duration: 340 })
    }

    w.postMessage({
      nodes: over.layoutNodes(),
      edges: data.edges.map((e) => ({ source: e.source, target: e.target })),
    })

    return () => {
      w.terminate()
      if (worker.current === w) worker.current = null
    }
  }, [data, palette, theme])

  useEffect(() => {
    const renderer = sigma.current
    if (!focusId || !renderer || !graph.current.hasNode(focusId)) return
    const display = renderer.getNodeDisplayData(focusId)
    if (!display) return
    renderer.getCamera().animate({ x: display.x, y: display.y, ratio: 0.6 }, { duration: 420 })
  }, [focusId])

  return (
    <>
      <div className="absolute inset-0" ref={container} />
      {/* Above Sigma and transparent to input: hit-testing runs against the card
          rectangles and edge curves, on the container beneath. */}
      <canvas className="pointer-events-none absolute inset-0" ref={canvas} />
    </>
  )
}
