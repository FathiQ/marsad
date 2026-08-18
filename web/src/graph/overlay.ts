import type Sigma from 'sigma'

import type { Graph as GraphData, GraphEdge, GraphNode } from '../api'
import type { LayoutNode } from './layout.worker'
import {
  MONO_STACK,
  SANS_STACK,
  edgeColor,
  hueFor,
  isUnprotected,
  oklch,
  paint,
  type NamespacePalette,
} from './style'

/**
 * The graph's visual layer: namespace containers, workload cards, edges routed
 * to access points, and animated flow.
 *
 * The organising idea is borrowed from Hubble's service map, and it is the right
 * one: **ports belong on the destination card, not on the edge**. A workload's
 * open ports are a property of that workload — "this is what I accept" — and
 * putting them there means a card answers the question you actually have while
 * looking at it, instead of making you trace every incoming line and read a
 * label off each one. Edges then terminate at the specific port they reach,
 * which turns "something connects to this" into "this connects to that port".
 *
 * Marsad can go further than Hubble here, because Hubble is showing observed
 * flows and Marsad is showing declared policy: every access point knows which
 * rule opened it, so the card is a direct index into the YAML.
 *
 * Sigma keeps the camera and the layout coordinate space. Everything visible is
 * drawn here, because cards, containers and port-terminated edges are all things
 * a node-and-line renderer has no concept of.
 */

const FLOW_STYLES = {
  allowed: { particles: 3, speed: 0.00028, radius: 2.1, alpha: 1 },
  approximate: { particles: 3, speed: 0.00028, radius: 2.1, alpha: 1 },
  default: { particles: 2, speed: 0.0001, radius: 1.4, alpha: 0.55 },
} as const

/* Card metrics, in layout units — one unit is one pixel at 100% zoom. */
const HEADER_H = 36
const ROW_H = 21
const PAD_X = 11
const MIN_W = 168
const MAX_W = 268
const GLYPH = 15
const RADIUS = 10

/**
 * Level-of-detail thresholds, and the clamp that keeps them from thrashing.
 *
 * Cards used to scale straight with the camera, which put the chip and dot
 * thresholds right where the default zoom lands: a small scroll flipped cards in
 * and out of existence and read as the graph blinking. Drawing is clamped to a
 * readable band so a card never shrinks to nothing, and the thresholds sit well
 * clear of where the view normally sits.
 */
const MIN_DRAW_SCALE = 0.7
const MAX_DRAW_SCALE = 1.25
const CHIP_SCALE = 0.5
const DOT_SCALE = 0.26

export interface AccessPoint {
  label: string
  protocol: string
  kind: GraphEdge['kind']
}

interface Card {
  id: string
  label: string
  kind: GraphNode['kind']
  workloadKind?: string
  namespace?: string
  count: number
  unprotected: boolean
  showKind: boolean
  access: AccessPoint[]
  /** Reachable from anything / able to reach anything, because no policy
   * isolates it. Stated on the card rather than drawn as edges — see setData. */
  openIn: boolean
  openOut: boolean
  w: number
  h: number
}

interface Edge {
  id: string
  source: string
  target: string
  kind: GraphEdge['kind']
  /** Index of the access point this edge reaches, or -1 for the card itself. */
  accessIndex: number
}

interface Rect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

interface Curve {
  id: string
  points: { x: number; y: number }[]
}

function truncate(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text
  let out = text
  while (out.length > 1 && ctx.measureText(`${out}…`).width > max) out = out.slice(0, -1)
  return `${out}…`
}

/** Glyphs drawn as paths: at this size a stroke is crisper than a rasterised
 * SVG, and there is nothing to load. */
function drawGlyph(ctx: CanvasRenderingContext2D, kind: string, x: number, y: number, s: number) {
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(s / 24, s / 24)
  ctx.translate(-12, -12)
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()

  switch (kind) {
    case 'StatefulSet':
      ctx.ellipse(12, 7, 6.5, 3, 0, 0, Math.PI * 2)
      ctx.moveTo(5.5, 7)
      ctx.lineTo(5.5, 17)
      ctx.ellipse(12, 17, 6.5, 3, 0, Math.PI, 0, true)
      ctx.moveTo(18.5, 17)
      ctx.lineTo(18.5, 7)
      break
    case 'DaemonSet':
      ctx.roundRect(4, 5.5, 16, 5, 1.5)
      ctx.roundRect(4, 13.5, 16, 5, 1.5)
      break
    case 'Job':
      ctx.moveTo(5.5, 12.5)
      ctx.lineTo(10, 17)
      ctx.lineTo(18.5, 7)
      break
    case 'CronJob':
      ctx.roundRect(4, 6, 16, 14, 2)
      ctx.moveTo(4, 10)
      ctx.lineTo(20, 10)
      ctx.moveTo(12, 13)
      ctx.lineTo(12, 16)
      ctx.lineTo(15, 16)
      break
    case 'domain':
      ctx.moveTo(7, 17.5)
      ctx.arc(9.5, 13, 4, Math.PI * 0.8, Math.PI * 1.75)
      ctx.arc(15, 12, 5, Math.PI * 1.3, Math.PI * 0.42)
      ctx.lineTo(7, 17.5)
      break
    case 'cidr':
      ctx.roundRect(3, 9, 18, 7, 2)
      ctx.moveTo(7.5, 12.5)
      ctx.lineTo(7.6, 12.5)
      ctx.moveTo(11.5, 12.5)
      ctx.lineTo(11.6, 12.5)
      ctx.moveTo(15.5, 12.5)
      ctx.lineTo(15.6, 12.5)
      break
    case 'world':
    case 'any':
      ctx.moveTo(12, 5)
      ctx.lineTo(12, 19)
      ctx.moveTo(6.2, 8.5)
      ctx.lineTo(17.8, 15.5)
      ctx.moveTo(17.8, 8.5)
      ctx.lineTo(6.2, 15.5)
      break
    case 'namespace':
      ctx.roundRect(4, 6.5, 16, 12, 2)
      ctx.moveTo(4, 10)
      ctx.lineTo(20, 10)
      ctx.moveTo(8, 6.5)
      ctx.lineTo(8, 4.5)
      ctx.lineTo(16, 4.5)
      ctx.lineTo(16, 6.5)
      break
    default:
      ctx.roundRect(4.5, 6.5, 15, 12, 2)
      ctx.moveTo(4.5, 10.5)
      ctx.lineTo(19.5, 10.5)
      break
  }
  ctx.stroke()
  ctx.restore()
}

export class OverlayRenderer {
  private frame = 0
  private startedAt = 0
  private cards: Card[] = []
  private cardsById = new Map<string, Card>()
  private edges: Edge[] = []
  private rects: Rect[] = []
  private curves: Curve[] = []
  private palette: NamespacePalette = new Map()
  private hovered: string | null = null
  private selected: string | null = null
  private animate = true
  private groupsVisible = true
  private measurer: CanvasRenderingContext2D

  constructor(
    private canvas: HTMLCanvasElement,
    private sigma: Sigma,
  ) {
    this.measurer = document.createElement('canvas').getContext('2d')!
  }

  setData(graph: GraphData, palette: NamespacePalette) {
    this.palette = palette
    const ctx = this.measurer

    /*
     * Allowed-by-default edges become a property of the card, not a line.
     *
     * Every workload no policy isolates gets an edge to and from the "any"
     * pseudo-node, so on a cluster with few policies that single node collects
     * two edges per workload and the result is a hairball radiating from one
     * point — the tangle that made the graph unreadable. Those lines also carry
     * no information the card does not already show: it is already ringed red
     * for being unprotected.
     *
     * So they are folded into two rows on the card. What remains drawn is the
     * traffic somebody actually wrote a rule about, which is the whole question
     * the graph exists to answer. An explicit allow-from-anywhere rule still
     * draws a real edge, because that is a decision rather than an absence.
     */
    const openIn = new Set<string>()
    const openOut = new Set<string>()
    const drawn: GraphEdge[] = []

    for (const e of graph.edges) {
      if (e.kind === 'default') {
        openIn.add(e.target)
        openOut.add(e.source)
        continue
      }
      drawn.push(e)
    }

    // A peer node left with nothing drawn is now pure clutter.
    const referenced = new Set<string>()
    for (const e of drawn) {
      referenced.add(e.source)
      referenced.add(e.target)
    }
    const isPeer = (n: GraphNode) => n.kind === 'any' || n.kind === 'world'
    const nodes = graph.nodes.filter((n) => !isPeer(n) || referenced.has(n.id))

    // Access points are collected from *incoming* edges: they describe what a
    // workload accepts, which is the question its card should answer.
    const accessByNode = new Map<string, AccessPoint[]>()
    const keyed = new Map<string, Set<string>>()

    for (const e of drawn) {
      const list = accessByNode.get(e.target) ?? []
      const seen = keyed.get(e.target) ?? new Set<string>()
      const ports = e.ports?.length ? e.ports : ['all ports']
      for (const port of ports) {
        const [num, proto] = port.includes('/') ? port.split('/') : [port, '']
        const key = `${num}/${proto}/${e.kind}`
        if (seen.has(key)) continue
        seen.add(key)
        list.push({ label: num ?? port, protocol: proto ?? '', kind: e.kind })
      }
      accessByNode.set(e.target, list)
      keyed.set(e.target, seen)
    }

    const kinds = new Set(nodes.filter((n) => n.kind === 'workload').map((n) => n.workloadKind))
    const showKind = kinds.size > 1

    this.cards = nodes.map((n) => {
      // Cap the list: a workload reachable on forty ports is a finding, not a
      // card, and the drawer is where the full list belongs.
      const access = (accessByNode.get(n.id) ?? []).slice(0, 5)
      const count = (n.kind === 'namespace' ? n.workloads : n.replicas) ?? 0

      ctx.font = `600 13px ${SANS_STACK}`
      const nameW = ctx.measureText(n.label).width
      ctx.font = `500 11px ${MONO_STACK}`
      const accessW = access.reduce(
        (max, a) => Math.max(max, ctx.measureText(`${a.label} ${a.protocol}`).width),
        0,
      )

      const open = { in: openIn.has(n.id), out: openOut.has(n.id) }
      const openRows = (open.in ? 1 : 0) + (open.out ? 1 : 0)

      const glyphW = n.kind === 'workload' && !showKind ? 0 : GLYPH + 8
      const badgeW = count > 1 ? 26 : 0
      const w = Math.max(
        MIN_W,
        Math.min(MAX_W, Math.max(PAD_X + glyphW + nameW + badgeW + PAD_X, accessW + 60)),
      )

      return {
        id: n.id,
        label: n.label,
        kind: n.kind,
        workloadKind: n.workloadKind,
        namespace: n.namespace,
        count,
        unprotected: n.kind === 'namespace' ? (n.unprotected ?? 0) > 0 : isUnprotected(n),
        showKind: n.kind !== 'workload' || showKind,
        access,
        openIn: open.in,
        openOut: open.out,
        w: Math.max(w, openRows ? 190 : 0),
        h: HEADER_H + (access.length + openRows ? (access.length + openRows) * ROW_H + 6 : 0),
      }
    })

    this.cardsById = new Map(this.cards.map((c) => [c.id, c]))

    this.edges = drawn.map((e) => {
      const target = this.cardsById.get(e.target)
      const first = e.ports?.length ? e.ports[0] : 'all ports'
      const [num] = (first ?? '').split('/')
      const accessIndex = target
        ? target.access.findIndex((a) => a.label === (num ?? '') && a.kind === e.kind)
        : -1
      return { id: e.id, source: e.source, target: e.target, kind: e.kind, accessIndex }
    })
  }

  /** The largest card, so the camera can be fitted to what is actually drawn
   * rather than to the bare node positions. */
  extent(): { width: number; height: number } {
    return this.cards.reduce(
      (max, c) => ({ width: Math.max(max.width, c.w), height: Math.max(max.height, c.h) }),
      { width: 0, height: 0 },
    )
  }

  /** Dimensions for the layout engine, which needs real sizes to reserve space. */
  layoutNodes(): LayoutNode[] {
    return this.cards.map((c) => ({
      id: c.id,
      width: c.w,
      height: c.h,
      group: c.kind === 'workload' ? c.namespace : undefined,
    }))
  }

  setHovered(id: string | null) {
    this.hovered = id
  }
  setSelected(id: string | null) {
    this.selected = id
  }
  setAnimate(on: boolean) {
    this.animate = on
  }
  setGroupsVisible(on: boolean) {
    this.groupsVisible = on
  }

  /** Cards are rectangles; a renderer that assumes circles cannot hit-test them. */
  hitTest(x: number, y: number): string | null {
    for (let i = this.rects.length - 1; i >= 0; i--) {
      const r = this.rects[i]!
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.id
    }
    return null
  }

  /**
   * Nearest edge within a few pixels, by sampling the curve.
   *
   * Sampling rather than solving: the curves are drawn here so their control
   * points are already known, a dozen samples is well inside a click's tolerance,
   * and this runs on click rather than per frame.
   */
  hitTestEdge(x: number, y: number, tolerance = 7): string | null {
    let best: string | null = null
    let bestDistance = tolerance
    for (const curve of this.curves) {
      for (const point of curve.points) {
        const distance = Math.hypot(point.x - x, point.y - y)
        if (distance < bestDistance) {
          bestDistance = distance
          best = curve.id
        }
      }
    }
    return best
  }

  start() {
    if (this.frame) return
    this.startedAt = performance.now()
    const loop = (now: number) => {
      this.draw(now - this.startedAt)
      this.frame = requestAnimationFrame(loop)
    }
    this.frame = requestAnimationFrame(loop)
  }

  stop() {
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = 0
  }

  /**
   * Resize only when the size has actually changed.
   *
   * Assigning canvas.width clears the bitmap even when the value is identical.
   * This is called on every Sigma render, and during a zoom Sigma renders many
   * times per frame — so an unconditional assignment wiped the overlay between
   * draws and the cards visibly strobed.
   */
  resize() {
    const { width, height } = this.sigma.getDimensions()
    const dpr = window.devicePixelRatio || 1
    const w = Math.round(width * dpr)
    const h = Math.round(height * dpr)
    if (this.canvas.width === w && this.canvas.height === h) return
    this.canvas.width = w
    this.canvas.height = h
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
  }

  private accent(card: Card): string {
    if (card.unprotected) return paint('danger')
    switch (card.kind) {
      case 'namespace':
      case 'workload':
        return oklch(0.72, 0.15, hueFor(this.palette, card.namespace ?? card.label))
      case 'domain':
        return paint('domain')
      case 'cidr':
        return paint('cidr')
      default:
        return paint('world')
    }
  }

  /**
   * Layout units to screen pixels.
   *
   * Measured from graphToViewport, not framedGraphToViewport: the "framed" space
   * is Sigma's internal [0,1] normalisation, so sampling it yields a factor in
   * the hundreds and every card is drawn thousands of pixels wide. Cards are
   * positioned in framed space (that is what display data is in) but *sized* in
   * graph space, and the two are not interchangeable.
   */
  private scale(): number {
    const a = this.sigma.graphToViewport({ x: 0, y: 0 })
    const b = this.sigma.graphToViewport({ x: 100, y: 0 })
    const scale = Math.abs(b.x - a.x) / 100
    return Number.isFinite(scale) && scale > 0 ? scale : 1
  }

  private draw(elapsed: number) {
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)

    const zoom = this.scale()
    const scale = Math.min(MAX_DRAW_SCALE, Math.max(MIN_DRAW_SCALE, zoom))
    const centres = new Map<string, { x: number; y: number }>()
    for (const card of this.cards) {
      const display = this.sigma.getNodeDisplayData(card.id)
      if (!display) continue
      centres.set(card.id, this.sigma.framedGraphToViewport(display))
    }

    this.rects = []
    this.curves = []

    if (this.groupsVisible && zoom > DOT_SCALE) this.drawGroups(ctx, centres, scale)
    this.drawEdges(ctx, centres, scale, zoom, elapsed)
    this.drawCards(ctx, centres, scale, zoom)
    // After the cards, because it reads as an annotation on one of them.
    this.drawExposure(ctx, scale, zoom)
  }

  /**
   * The selected card's exposure, drawn as edges to "anything".
   *
   * Openness is stated as two rows on the card because drawing it for every
   * unprotected workload is the hairball that made the graph unreadable — two
   * lines per workload converging on a single point, carrying nothing the red
   * ring did not already say. That reasoning still holds for the picture as a
   * whole, and none of this changes it.
   *
   * It does not hold for the one card somebody just clicked. A row of text
   * states the fact; it does not show the shape, and the shape is what a graph
   * is for. Two lines, on the card being asked about, cost nothing and answer
   * the question — and they sit on the same left-to-right axis as every real
   * edge, so "reaches" and "is reached by" read the same way here as they do
   * everywhere else.
   */
  private drawExposure(ctx: CanvasRenderingContext2D, scale: number, zoom: number) {
    if (this.selected === null || zoom < DOT_SCALE) return
    const card = this.cardsById.get(this.selected)
    if (!card || (!card.openIn && !card.openOut)) return
    const rect = this.rects.find((r) => r.id === this.selected)
    if (!rect) return

    const danger = paint('danger')
    const plate = paint('plate')
    const label = 'anything'
    const font = `600 ${Math.round(11 * scale)}px ${SANS_STACK}`

    ctx.save()
    ctx.font = font
    const textW = ctx.measureText(label).width
    const padX = 10 * scale
    const pillW = textW + padX * 2
    const pillH = 24 * scale
    const gap = 58 * scale
    const midY = rect.y + rect.h / 2
    const pillY = midY - pillH / 2

    const pill = (x: number, dy: number) => {
      ctx.beginPath()
      ctx.roundRect(x, pillY + dy, pillW, pillH, pillH / 2)
      ctx.fillStyle = plate
      ctx.fill()
      ctx.lineWidth = 1
      ctx.setLineDash([3 * scale, 3 * scale])
      ctx.strokeStyle = danger
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = danger
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, x + pillW / 2, midY + dy)
    }

    // Dashed, because no rule declares this: it is what happens in the absence
    // of one, and it should not read as a written allow.
    const arrow = (fromX: number, toX: number, dy: number) => {
      const y = midY + dy
      ctx.beginPath()
      ctx.setLineDash([4 * scale, 4 * scale])
      ctx.lineWidth = 1.4 * Math.max(scale, 0.7)
      ctx.strokeStyle = danger
      ctx.moveTo(fromX, y)
      ctx.lineTo(toX, y)
      ctx.stroke()
      ctx.setLineDash([])

      const size = 6 * Math.max(scale, 0.6)
      const dir = Math.sign(toX - fromX) || 1
      ctx.beginPath()
      ctx.moveTo(toX, y)
      ctx.lineTo(toX - dir * size, y - size * 0.45)
      ctx.lineTo(toX - dir * size, y + size * 0.45)
      ctx.closePath()
      ctx.fillStyle = danger
      ctx.fill()
    }

    // Selecting a card opens the inspector, which narrows the canvas under it,
    // so the side a pill wants is often off screen — and a card that says "open
    // to anything" while drawing nothing reads as broken. Prefer the side that
    // matches the flow, fall back to the other, and let the arrowhead carry the
    // direction when the side cannot.
    const edgePad = 6 * scale
    const minGap = 16 * scale
    const canvasW = this.canvas.width / (window.devicePixelRatio || 1)
    const right = rect.x + rect.w
    const roomLeft = rect.x - edgePad >= pillW + minGap
    const roomRight = canvasW - edgePad - right >= pillW + minGap
    const pick = (preferred: 'left' | 'right'): 'left' | 'right' | null => {
      if (preferred === 'left') return roomLeft ? 'left' : roomRight ? 'right' : null
      return roomRight ? 'right' : roomLeft ? 'left' : null
    }

    // Sources on the left, destinations on the right — the same axis the
    // layered layout puts every other edge on.
    const inSide = card.openIn ? pick('left') : null
    const outSide = card.openOut ? pick('right') : null
    // Both crowded onto one side would overlap, so they part vertically.
    const lift = inSide !== null && inSide === outSide ? pillH * 0.72 : 0

    const place = (which: 'left' | 'right', dy: number, incoming: boolean) => {
      const wanted = which === 'left' ? rect.x - gap - pillW : right + gap
      const x =
        which === 'left'
          ? Math.max(edgePad, wanted)
          : Math.min(wanted, canvasW - edgePad - pillW)
      pill(x, dy)
      const cardEdge = which === 'left' ? rect.x : right
      const pillEdge = which === 'left' ? x + pillW : x
      if (incoming) arrow(pillEdge, cardEdge, dy)
      else arrow(cardEdge, pillEdge, dy)
    }

    if (inSide) place(inSide, -lift, true)
    if (outSide) place(outSide, lift, false)

    ctx.restore()
  }

  /**
   * Namespace containers.
   *
   * A dashed box around everything in a namespace does more for comprehension
   * than any per-node styling can: it turns "which of these are related" from a
   * colour-matching exercise into something you simply see.
   */
  private drawGroups(
    ctx: CanvasRenderingContext2D,
    centres: Map<string, { x: number; y: number }>,
    scale: number,
  ) {
    const bounds = new Map<string, { x1: number; y1: number; x2: number; y2: number }>()

    for (const card of this.cards) {
      if (card.kind !== 'workload' || !card.namespace) continue
      const c = centres.get(card.id)
      if (!c) continue
      const w = card.w * scale
      const h = card.h * scale
      const box = bounds.get(card.namespace) ?? {
        x1: Infinity,
        y1: Infinity,
        x2: -Infinity,
        y2: -Infinity,
      }
      box.x1 = Math.min(box.x1, c.x - w / 2)
      box.y1 = Math.min(box.y1, c.y - h / 2)
      box.x2 = Math.max(box.x2, c.x + w / 2)
      box.y2 = Math.max(box.y2, c.y + h / 2)
      bounds.set(card.namespace, box)
    }

    const pad = 22 * scale
    ctx.save()
    ctx.setLineDash([6 * scale, 5 * scale])
    ctx.lineWidth = 1

    for (const [namespace, box] of bounds) {
      if (!Number.isFinite(box.x1)) continue
      const x = box.x1 - pad
      const y = box.y1 - pad * 1.5
      const w = box.x2 - box.x1 + pad * 2
      const h = box.y2 - box.y1 + pad * 2.5
      const hue = hueFor(this.palette, namespace)

      ctx.fillStyle = oklch(0.72, 0.15, hue)
      ctx.globalAlpha = 0.045
      ctx.beginPath()
      ctx.roundRect(x, y, w, h, 14 * scale)
      ctx.fill()

      ctx.globalAlpha = 0.4
      ctx.strokeStyle = oklch(0.72, 0.13, hue)
      ctx.stroke()

      ctx.globalAlpha = 0.85
      ctx.setLineDash([])
      ctx.font = `600 ${Math.round(11 * scale)}px ${SANS_STACK}`
      ctx.fillStyle = oklch(0.72, 0.14, hue)
      ctx.textBaseline = 'middle'
      ctx.fillText(namespace, x + 12 * scale, y + 13 * scale)
      ctx.setLineDash([6 * scale, 5 * scale])
    }

    ctx.restore()
  }

  /** Where an edge attaches on the target: the access point it reaches, or the
   * card's left edge when it reaches the card as a whole. */
  private attachPoint(
    card: Card,
    centre: { x: number; y: number },
    accessIndex: number,
    scale: number,
  ): { x: number; y: number } {
    const left = centre.x - (card.w * scale) / 2
    if (accessIndex < 0) return { x: left, y: centre.y }
    const top = centre.y - (card.h * scale) / 2
    const rowY = top + (HEADER_H + 6 + accessIndex * ROW_H + ROW_H / 2) * scale
    return { x: left, y: rowY }
  }

  private drawEdges(
    ctx: CanvasRenderingContext2D,
    centres: Map<string, { x: number; y: number }>,
    scale: number,
    zoom: number,
    elapsed: number,
  ) {
    // Outgoing edges are fanned across the source card's trailing edge rather
    // than all leaving its midpoint. Departing from one point bundles them into
    // a single indistinguishable rope for the first hundred pixels, which is
    // exactly where a reader is trying to work out what goes where.
    const outgoing = new Map<string, string[]>()
    for (const edge of this.edges) {
      const list = outgoing.get(edge.source) ?? []
      list.push(edge.id)
      outgoing.set(edge.source, list)
    }
    for (const [source, ids] of outgoing) {
      const from = centres.get(source)
      if (!from) continue
      ids.sort((a, b) => {
        const ta = centres.get(this.edges.find((e) => e.id === a)!.target)
        const tb = centres.get(this.edges.find((e) => e.id === b)!.target)
        return (ta?.y ?? 0) - (tb?.y ?? 0)
      })
    }
    const fanIndex = new Map<string, { index: number; total: number }>()
    for (const [, ids] of outgoing) {
      ids.forEach((id, index) => fanIndex.set(id, { index, total: ids.length }))
    }

    // Two cards that reach each other produced two curves bowing the same way,
    // which overlap into what looks like one line pointing at itself. Bowing
    // them opposite ways turns the pair into a legible two-lane path. The
    // direction is chosen by comparing the ids, so it is stable across renders.
    const pairs = new Set(this.edges.map((e) => `${e.source}\u0000${e.target}`))
    const bowed = new Map<string, number>()
    for (const edge of this.edges) {
      const reversed = pairs.has(`${edge.target}\u0000${edge.source}`)
      bowed.set(edge.id, reversed ? (edge.source < edge.target ? 1 : -1) : 0)
    }

    for (const edge of this.edges) {
      const sourceCard = this.cardsById.get(edge.source)
      const targetCard = this.cardsById.get(edge.target)
      const from = centres.get(edge.source)
      const to = centres.get(edge.target)
      if (!sourceCard || !targetCard || !from || !to) continue

      const dimmed =
        this.hovered !== null && edge.source !== this.hovered && edge.target !== this.hovered

      const fan = fanIndex.get(edge.id) ?? { index: 0, total: 1 }
      const sourceH = (zoom < CHIP_SCALE ? HEADER_H : sourceCard.h) * scale
      // Spread across the middle 70% of the card's height, so the outermost
      // edges still visibly touch the card rather than its corners.
      const spread = sourceH * 0.7
      const offset =
        fan.total > 1 ? (fan.index / (fan.total - 1) - 0.5) * spread : 0

      const start = {
        x: from.x + (sourceCard.w * scale) / 2,
        y: from.y - (sourceCard.h * scale) / 2 + sourceH / 2 + offset,
      }
      const end = this.attachPoint(
        targetCard,
        to,
        zoom < CHIP_SCALE ? -1 : edge.accessIndex,
        scale,
      )

      // Horizontal control points: the layout is left-to-right, so a curve that
      // leaves and arrives horizontally reads as a route rather than a rubber band.
      const dx = Math.max(36 * scale, Math.abs(end.x - start.x) * 0.42)
      const bow = (bowed.get(edge.id) ?? 0) * 26 * scale
      const c1 = { x: start.x + dx, y: start.y + bow }
      const c2 = { x: end.x - dx, y: end.y + bow }

      const samples: { x: number; y: number }[] = []
      for (let i = 0; i <= 14; i++) {
        const t = i / 14
        const u = 1 - t
        samples.push({
          x: u * u * u * start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x,
          y: u * u * u * start.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y,
        })
      }
      this.curves.push({ id: edge.id, points: samples })

      const colour = edgeColor({ kind: edge.kind } as GraphEdge)
      ctx.globalAlpha = dimmed ? 0.12 : edge.kind === 'default' ? 0.5 : 0.9
      ctx.strokeStyle = colour
      ctx.lineWidth = (edge.kind === 'default' ? 1 : 1.8) * Math.max(scale, 0.5)
      if (edge.kind === 'default') ctx.setLineDash([5 * scale, 4 * scale])

      const headroom = (edge.kind === 'default' ? 4 : 5.5) * Math.max(scale, 0.6)
      const tx = end.x - c2.x
      const ty = end.y - c2.y
      const tl = Math.hypot(tx, ty) || 1
      const tip = { x: end.x - (tx / tl) * headroom, y: end.y - (ty / tl) * headroom }

      ctx.beginPath()
      ctx.moveTo(start.x, start.y)
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, tip.x, tip.y)
      ctx.stroke()
      ctx.setLineDash([])

      // An arrowhead at the destination. Without one a policy graph is unreadable:
      // "A relates to B" is not the same statement as "A may reach B", and the
      // whole point is the direction.
      if (!dimmed) {
        const tangentX = end.x - c2.x
        const tangentY = end.y - c2.y
        const length = Math.hypot(tangentX, tangentY) || 1
        const ux = tangentX / length
        const uy = tangentY / length
        const size = (edge.kind === 'default' ? 5 : 6.5) * Math.max(scale, 0.6)
        const baseX = end.x - ux * size
        const baseY = end.y - uy * size

        ctx.beginPath()
        ctx.moveTo(end.x, end.y)
        ctx.lineTo(baseX - uy * size * 0.45, baseY + ux * size * 0.45)
        ctx.lineTo(baseX + uy * size * 0.45, baseY - ux * size * 0.45)
        ctx.closePath()
        ctx.fillStyle = colour
        ctx.fill()

        // A small socket where the edge leaves, so a card shows what it reaches
        // as well as what reaches it.
        if (zoom > CHIP_SCALE) {
          ctx.beginPath()
          ctx.arc(start.x, start.y, 2.2 * scale, 0, Math.PI * 2)
          ctx.fillStyle = colour
          ctx.globalAlpha = (dimmed ? 0.12 : 0.75) as number
          ctx.fill()
          ctx.globalAlpha = dimmed ? 0.12 : edge.kind === 'default' ? 0.5 : 0.9
        }
      }

      if (this.animate && !dimmed) {
        const style = FLOW_STYLES[edge.kind]
        const phase = (elapsed * style.speed) % 1
        for (let i = 0; i < style.particles; i++) {
          const t = (phase + i / style.particles) % 1
          const u = 1 - t
          const px =
            u * u * u * start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x
          const py =
            u * u * u * start.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y
          ctx.globalAlpha = (0.25 + Math.sin(t * Math.PI) * 0.75) * style.alpha
          ctx.beginPath()
          ctx.arc(px, py, style.radius * Math.max(scale, 0.6), 0, Math.PI * 2)
          ctx.fillStyle = colour
          ctx.fill()
        }
      }
    }
    ctx.globalAlpha = 1
  }

  private drawCards(
    ctx: CanvasRenderingContext2D,
    centres: Map<string, { x: number; y: number }>,
    scale: number,
    zoom: number,
  ) {
    const fg = paint('fg')
    const muted = paint('muted')
    const faint = paint('faint')
    const plate = paint('plate')
    const plateEdge = paint('plateEdge')
    const accentColour = paint('accent')
    const danger = paint('danger')

    for (const card of this.cards) {
      const centre = centres.get(card.id)
      if (!centre) continue

      const accent = this.accent(card)
      const dimmed = this.hovered !== null && this.hovered !== card.id && !this.isNeighbour(card.id)
      ctx.globalAlpha = dimmed ? 0.28 : 1

      if (zoom < DOT_SCALE) {
        ctx.beginPath()
        ctx.arc(centre.x, centre.y, 4, 0, Math.PI * 2)
        ctx.fillStyle = accent
        ctx.fill()
        this.rects.push({ id: card.id, x: centre.x - 7, y: centre.y - 7, w: 14, h: 14 })
        ctx.globalAlpha = 1
        continue
      }

      const compact = zoom < CHIP_SCALE
      const w = card.w * scale
      const h = (compact ? HEADER_H : card.h) * scale
      const x = Math.round(centre.x - w / 2)
      const y = Math.round(centre.y - (card.h * scale) / 2)
      const r = RADIUS * scale

      this.rects.push({ id: card.id, x, y, w, h })

      ctx.beginPath()
      ctx.roundRect(x, y, w, h, r)
      ctx.fillStyle = plate
      ctx.fill()

      // The namespace colour as a bar on the leading edge: present enough to
      // group by, quiet enough not to shout on every card.
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(x, y, w, h, r)
      ctx.clip()
      ctx.fillStyle = accent
      ctx.fillRect(x, y, 3.5 * scale, h)
      if (!compact && card.access.length) {
        ctx.fillStyle = plateEdge
        ctx.fillRect(x, y + HEADER_H * scale, w, 1)
      }
      ctx.restore()

      ctx.lineWidth = 1
      ctx.strokeStyle =
        this.selected === card.id ? accentColour : card.unprotected ? danger : plateEdge
      ctx.beginPath()
      ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r)
      ctx.stroke()

      // Header
      let cursor = x + PAD_X * scale
      const headerY = y + (HEADER_H / 2) * scale

      if (card.showKind) {
        ctx.strokeStyle = muted
        drawGlyph(ctx, card.workloadKind ?? card.kind, cursor + (GLYPH * scale) / 2, headerY, GLYPH * scale)
        cursor += (GLYPH + 8) * scale
      }

      const badgeW = card.count > 1 ? 26 * scale : 0
      ctx.font = `600 ${Math.round(13 * scale)}px ${SANS_STACK}`
      ctx.fillStyle = fg
      ctx.textBaseline = 'middle'
      const room = x + w - PAD_X * scale - badgeW - cursor
      ctx.fillText(truncate(ctx, card.label, room), cursor, headerY)

      if (card.count > 1) {
        const bw = 22 * scale
        const bh = 16 * scale
        const bx = x + w - PAD_X * scale - bw
        ctx.beginPath()
        ctx.roundRect(bx, headerY - bh / 2, bw, bh, bh / 2)
        ctx.fillStyle = plateEdge
        ctx.fill()
        ctx.font = `600 ${Math.round(10.5 * scale)}px ${SANS_STACK}`
        ctx.fillStyle = muted
        ctx.textAlign = 'center'
        ctx.fillText(String(card.count), bx + bw / 2, headerY)
        ctx.textAlign = 'left'
      }

      // Access points, then the open rows. Both are drawn as rows so the card
      // reads as one list of "what can reach me, and how".
      if (!compact) {
        const openRows: { label: string; incoming: boolean }[] = []
        if (card.openIn) openRows.push({ label: 'open from anything', incoming: true })
        if (card.openOut) openRows.push({ label: 'open to anything', incoming: false })

        openRows.forEach((row, i) => {
          const rowY = y + (HEADER_H + 6 + (card.access.length + i) * ROW_H + ROW_H / 2) * scale

          ctx.strokeStyle = danger
          ctx.lineWidth = 1.2 * scale
          ctx.beginPath()
          if (row.incoming) {
            ctx.moveTo(x + 10 * scale, rowY)
            ctx.lineTo(x + 20 * scale, rowY)
            ctx.moveTo(x + 17 * scale, rowY - 2.5 * scale)
            ctx.lineTo(x + 20 * scale, rowY)
            ctx.lineTo(x + 17 * scale, rowY + 2.5 * scale)
          } else {
            ctx.moveTo(x + 20 * scale, rowY)
            ctx.lineTo(x + 10 * scale, rowY)
            ctx.moveTo(x + 13 * scale, rowY - 2.5 * scale)
            ctx.lineTo(x + 10 * scale, rowY)
            ctx.lineTo(x + 13 * scale, rowY + 2.5 * scale)
          }
          ctx.stroke()

          ctx.font = `500 ${Math.round(10.5 * scale)}px ${SANS_STACK}`
          ctx.fillStyle = danger
          ctx.fillText(row.label, x + 26 * scale, rowY)
        })

        card.access.forEach((point, i) => {
          const rowY = y + (HEADER_H + 6 + i * ROW_H + ROW_H / 2) * scale
          const colour = edgeColor({ kind: point.kind } as GraphEdge)

          ctx.beginPath()
          ctx.arc(x + 10 * scale, rowY, 2.6 * scale, 0, Math.PI * 2)
          ctx.strokeStyle = colour
          ctx.lineWidth = 1.4 * scale
          ctx.stroke()

          ctx.strokeStyle = colour
          ctx.lineWidth = 1.2 * scale
          ctx.beginPath()
          ctx.moveTo(x + 16 * scale, rowY)
          ctx.lineTo(x + 21 * scale, rowY)
          ctx.moveTo(x + 18.5 * scale, rowY - 2 * scale)
          ctx.lineTo(x + 21 * scale, rowY)
          ctx.lineTo(x + 18.5 * scale, rowY + 2 * scale)
          ctx.stroke()

          ctx.font = `500 ${Math.round(11 * scale)}px ${MONO_STACK}`
          ctx.fillStyle = colour
          ctx.fillText(point.label, x + 26 * scale, rowY)

          if (point.protocol) {
            const offset = ctx.measureText(point.label).width + 32 * scale
            ctx.font = `500 ${Math.round(9.5 * scale)}px ${SANS_STACK}`
            ctx.fillStyle = faint
            ctx.fillText(point.protocol, x + offset, rowY)
          }
        })
      }

      ctx.globalAlpha = 1
    }
  }

  private isNeighbour(id: string): boolean {
    if (!this.hovered) return false
    return this.edges.some(
      (e) =>
        (e.source === this.hovered && e.target === id) ||
        (e.target === this.hovered && e.source === id),
    )
  }
}
