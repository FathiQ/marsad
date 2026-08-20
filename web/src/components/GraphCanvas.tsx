import { useEffect, useRef, type MutableRefObject } from 'react'
import Graph from 'graphology'
import Sigma from 'sigma'

import type { Graph as GraphData, GraphEdge, GraphNode } from '../api'
import { OverlayRenderer } from '../graph/overlay'
import { isUnprotected, type NamespacePalette } from '../graph/style'
import type { LayoutResult } from '../graph/layout.worker'

/**
 * The camera, for the controls that live outside this component.
 *
 * Handed out through a ref rather than driven by props, because zooming is an
 * event and not a state: a `zoom` prop would make the parent responsible for
 * tracking a number that Sigma already owns and animates.
 */
export interface GraphControls {
  zoomIn: () => void
  zoomOut: () => void
  /** Back to the framing the fit chose, not to Sigma's arbitrary default. */
  fit: () => void
  /** Where everything is, and which part of it is on screen. For the minimap,
   * which has to show what is *not* in view — that being the whole point. */
  snapshot: () => MinimapSnapshot | null
  /** Move the camera to a point in graph space. */
  panTo: (x: number, y: number) => void
}

export interface MinimapSnapshot {
  nodes: { x: number; y: number; danger: boolean }[]
  /** The viewport, in the same graph coordinates as the nodes. */
  view: { x0: number; y0: number; x1: number; y1: number }
}

interface Props {
  data: GraphData
  palette: NamespacePalette
  theme: 'dark' | 'light'
  animateFlow: boolean
  showGroups: boolean
  /** Draw allowed-by-default edges as lines. On only when the graph has been
   * narrowed to unprotected workloads, where the fan-out is the picture rather
   * than noise on top of one. */
  showDefaultEdges: boolean
  selectedId: string | null
  focusId: string | null
  /** Changes when the user asks to see something different — a level switch, a
   * namespace scope, a posture filter. Only the parent can tell that apart from
   * the stream pushing a new graph, and it is the difference between reframing
   * being helpful and it being the camera moving on its own. */
  viewToken: string
  /** Populated with the camera controls once the renderer exists. */
  controls?: MutableRefObject<GraphControls | null>
  onSelectNode: (node: GraphNode) => void
  /** The click point comes with it: the popover is anchored to where the
   * pointer actually landed, not to the edge's midpoint, which for a long
   * curve can be most of a screen away from what was clicked. */
  onSelectEdge: (edge: GraphEdge, at: { x: number; y: number }) => void
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
  showDefaultEdges,
  selectedId,
  focusId,
  viewToken,
  controls,
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
  /** The node set the camera was last fitted to, so a live push that changes
   * nothing structural leaves the view where the user put it. */
  const fitted = useRef<string | null>(null)
  /** Set once the user has pointed the camera themselves. From then on the view
   * is theirs: workloads coming and going must not drag it away from what they
   * are looking at. Cleared when they ask to see something different. */
  const userMoved = useRef(false)
  /** The framing the fit last computed, so "fit" can return to it rather than
   * to Sigma's default of ratio 1 — which on a small graph is a magnification
   * nobody asked for. */
  const lastFit = useRef<{ x: number; y: number; ratio: number } | null>(null)
  /** Which nodes are a finding, so the minimap can keep them red off screen. */
  const dangerIds = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!container.current || !canvas.current) return

    const renderer = new Sigma(graph.current, container.current, {
      defaultNodeColor: 'rgba(0,0,0,0)',
      renderLabels: false,
      renderEdgeLabels: false,
      defaultDrawNodeHover: () => {},
      minCameraRatio: 0.06,
      // High enough that a small graph can be framed at natural size rather
      // than magnified to fill the viewport: a three-workload namespace needs
      // roughly 4.2, and the old ceiling of 4 clamped exactly those cases.
      maxCameraRatio: 16,
    })
    sigma.current = renderer

    const over = new OverlayRenderer(canvas.current, renderer)
    overlay.current = over
    over.resize()
    over.start()

    if (controls) {
      // Zooming by button is the user aiming the camera just as much as a wheel
      // gesture is, so it claims the view the same way.
      controls.current = {
        zoomIn: () => {
          userMoved.current = true
          renderer.getCamera().animatedZoom({ duration: 220 })
        },
        zoomOut: () => {
          userMoved.current = true
          renderer.getCamera().animatedUnzoom({ duration: 220 })
        },
        fit: () => {
          userMoved.current = false
          const to = lastFit.current
          if (to) renderer.getCamera().animate(to, { duration: 320 })
          else renderer.getCamera().animatedReset({ duration: 320 })
        },
        snapshot: () => {
          const g = graph.current
          if (!g.order) return null

          const nodes: MinimapSnapshot['nodes'] = []
          g.forEachNode((id, attrs) => {
            nodes.push({
              x: attrs.x as number,
              y: attrs.y as number,
              // Read from the node data, not from what the overlay currently
              // paints: a dot for an unprotected workload has to stay red when
              // the workload is off screen, which is exactly when it matters.
              danger: dangerIds.current.has(id),
            })
          })

          const { width, height } = renderer.getDimensions()
          const topLeft = renderer.viewportToGraph({ x: 0, y: 0 })
          const bottomRight = renderer.viewportToGraph({ x: width, y: height })
          return {
            nodes,
            view: {
              x0: Math.min(topLeft.x, bottomRight.x),
              y0: Math.min(topLeft.y, bottomRight.y),
              x1: Math.max(topLeft.x, bottomRight.x),
              y1: Math.max(topLeft.y, bottomRight.y),
            },
          }
        },
        panTo: (x, y) => {
          userMoved.current = true
          renderer.getCamera().animate({ x, y }, { duration: 260 })
        },
      }
    }

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
    // On window, not on the canvas: a pan very often ends with the pointer off
    // the stage — over the rail, or outside the document entirely — and Sigma
    // keeps panning all the way. Listening on the canvas alone missed exactly
    // the drags that travelled furthest.
    const onUp = (event: MouseEvent) => {
      const from = downAt
      downAt = null
      if (!from) return

      const { x, y } = localPoint(event)
      // A drag, not a click: it aimed the camera, and must not select.
      if (Math.hypot(x - from.x, y - from.y) > 4) {
        userMoved.current = true
        return
      }
      // A click that began on the stage but ended off it selects nothing.
      if (event.target !== element && !element.contains(event.target as Node)) return

      const node = over.hitTest(x, y)
      if (node) {
        const found = nodeIndex.current.get(node)
        if (found) onSelectNode(found)
        return
      }
      const edge = over.hitTestEdge(x, y)
      if (edge) {
        const found = edgeIndex.current.get(edge)
        if (found) onSelectEdge(found, { x, y })
        return
      }
      onClearSelection()
    }

    // Zoom and touch panning, which never pass through the mouse handlers.
    const onUserCamera = () => {
      userMoved.current = true
    }

    element.addEventListener('mousemove', onMove)
    element.addEventListener('mouseleave', onLeave)
    element.addEventListener('mousedown', onDown)
    window.addEventListener('mouseup', onUp)
    element.addEventListener('wheel', onUserCamera, { passive: true })
    element.addEventListener('touchmove', onUserCamera, { passive: true })

    return () => {
      element.removeEventListener('mousemove', onMove)
      element.removeEventListener('mouseleave', onLeave)
      element.removeEventListener('mousedown', onDown)
      window.removeEventListener('mouseup', onUp)
      element.removeEventListener('wheel', onUserCamera)
      element.removeEventListener('touchmove', onUserCamera)
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

  useEffect(() => {
    overlay.current?.setShowDefaultEdges(showDefaultEdges)
  }, [showDefaultEdges])

  // Rebuild on data or theme change. Theme is a dependency because the card
  // colours are resolved at build time, not per frame.
  useEffect(() => {
    const over = overlay.current
    const g = graph.current
    if (!over) return

    const previous = new Map<string, { x: number; y: number }>()
    g.forEachNode((id, attrs) => previous.set(id, { x: attrs.x as number, y: attrs.y as number }))

    nodeIndex.current = new Map(data.nodes.map((n) => [n.id, n]))
    dangerIds.current = new Set(data.nodes.filter(isUnprotected).map((n) => n.id))
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

      // Refitting on every push is what made the camera appear to zoom out on
      // its own: the stream sends a fresh graph on any cluster change, so on a
      // busy cluster a pan or zoom was thrown away seconds after it was made.
      // Reframing is only warranted when the set of nodes changed — a filter,
      // a level switch, a workload appearing — not when the same graph arrived
      // again.
      const signature = data.nodes.map((n) => n.id).join(' ')
      const alreadyFitted = signature === fitted.current
      fitted.current = signature

      // Fit to what is drawn, not to where the nodes are. Sigma frames the node
      // *positions*, which for card nodes leaves half a card hanging off each
      // edge of the viewport — the wider the cards, the worse it looks.
      //
      // Each axis is padded on its own, and an axis with no span contributes
      // nothing rather than discarding the other one's padding: a single row or
      // column is a real shape, not a degenerate case to bail out of.
      const spanX = maxX - minX
      const spanY = maxY - minY
      const card = over.extent()
      const padX = Number.isFinite(spanX) && spanX > 0 ? (spanX + card.width) / spanX : 1
      const padY = Number.isFinite(spanY) && spanY > 0 ? (spanY + card.height) / spanY : 1
      let ratio = Math.max(padX, padY, 1) * 1.06

      // Never magnify past natural size.
      //
      // Sigma scales whatever it is given to fill the viewport, so a namespace
      // with three workloads was blown up until it did. Card *drawing* is
      // clamped to a readable band, but their positions are not, so the cards
      // stayed the size they always are while the gaps between them grew to
      // most of the screen — three cards adrift in an empty column. One layout
      // unit is one pixel at 100%, so holding the scale at or below 1:1 is the
      // whole fix; a graph bigger than the viewport is unaffected.
      const span = Math.max(Number.isFinite(spanX) ? spanX : 0, Number.isFinite(spanY) ? spanY : 0)
      const box = container.current
      const viewport = box ? Math.min(box.clientWidth, box.clientHeight) : 0
      if (span > 0 && viewport > 0) ratio = Math.max(ratio, viewport / span)

      // Recorded even when the camera is not moved, so the fit button has
      // somewhere to return to. That is the whole reason this is computed
      // before the two bail-outs below rather than after them.
      lastFit.current = { x: 0.5, y: 0.5, ratio }

      // The node set has to have changed for a reframe to be warranted, and the
      // user must not have aimed the camera themselves. A Job finishing or a
      // Deployment scaling changes the set without being any reason to pull
      // someone away from what they were reading; asking to see something
      // different clears userMoved, and reframes.
      if (alreadyFitted || userMoved.current) return

      renderer.getCamera().animate(lastFit.current, { duration: 340 })
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
    // Jumping to a search result is the user choosing where to look just as
    // much as dragging there is, so the camera stays put afterwards.
    userMoved.current = true
    renderer.getCamera().animate({ x: display.x, y: display.y, ratio: 0.6 }, { duration: 420 })
  }, [focusId])

  // A new view is a request to see it. Whatever the camera was pointed at
  // belonged to the old one, so hand framing back to the fit.
  useEffect(() => {
    userMoved.current = false
    fitted.current = null
  }, [viewToken])

  return (
    <>
      <div className="absolute inset-0" ref={container} />
      {/* Above Sigma and transparent to input: hit-testing runs against the card
          rectangles and edge curves, on the container beneath. */}
      <canvas className="pointer-events-none absolute inset-0" ref={canvas} />
    </>
  )
}
