import type Sigma from 'sigma'

import type { Graph as GraphData, GraphEdge, GraphNode } from '../api'
import {
  edgeColor,
  edgeLabel,
  hueFor,
  isUnprotected,
  oklch,
  paint,
  type NamespacePalette,
} from './style'

/**
 * The overlay: node cards and animated flow, drawn on a 2D canvas above Sigma.
 *
 * Nodes are cards rather than circles, for two reasons that came out of looking
 * at the thing rather than reasoning about it.
 *
 * A circle can hold a colour and a glyph and nothing else, so the name — the one
 * piece of information a viewer actually needs — has to sit outside it, colliding
 * with neighbours and edges. A card holds the name, and the rest of the interface
 * is already made of cards and panels, so it stops looking like a diagram bolted
 * onto an app.
 *
 * The second reason is subtler. Repeating a mark across every node conveys
 * nothing: at namespace level *every* node is a namespace, so a folder icon on
 * all of them is pure noise, and a red ring on most of them stops reading as a
 * warning. Cards let each signal appear only where it distinguishes — the kind
 * icon only when kinds differ, the alert only as a small chip.
 *
 * Sigma keeps the camera, the edges and the layout. This layer owns node drawing
 * and node hit-testing, because a rectangle cannot be hit-tested by a renderer
 * that assumes circles.
 */

const FLOW_STYLES = {
  allowed: { particles: 3, speed: 0.00026, radius: 2.2, alpha: 1 },
  approximate: { particles: 3, speed: 0.00026, radius: 2.2, alpha: 1 },
  default: { particles: 2, speed: 0.00009, radius: 1.5, alpha: 0.5 },
} as const

/** Below this the cards would be unreadable anyway, so they collapse to dots. */
const DOT_SCALE = 0.55
const MAX_LABEL = 22

export interface OverlayNode {
  id: string
  label: string
  kind: GraphNode['kind']
  workloadKind?: string
  namespace?: string
  replicas?: number
  workloads?: number
  unprotected: number
  showKind: boolean
}

export interface OverlayEdge {
  id: string
  source: string
  target: string
  kind: GraphEdge['kind']
  label: string
  curvature: number
}

interface Rect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

function controlPoint(x1: number, y1: number, x2: number, y2: number, c: number): [number, number] {
  return [(x1 + x2) / 2 + (y2 - y1) * c, (y1 + y2) / 2 - (x2 - x1) * c]
}

function pointOnCurve(
  t: number, x1: number, y1: number, cx: number, cy: number, x2: number, y2: number,
): [number, number] {
  const u = 1 - t
  return [u * u * x1 + 2 * u * t * cx + t * t * x2, u * u * y1 + 2 * u * t * cy + t * t * y2]
}

function truncate(text: string, max = MAX_LABEL): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Glyphs drawn as paths rather than images: at this size a stroke drawn
 * directly is crisper than a rasterised SVG, and needs no loading. */
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
    case 'StatefulSet': // cylinder
      ctx.ellipse(12, 6, 7, 3, 0, 0, Math.PI * 2)
      ctx.moveTo(5, 6)
      ctx.lineTo(5, 18)
      ctx.ellipse(12, 18, 7, 3, 0, Math.PI, 0, true)
      ctx.moveTo(19, 18)
      ctx.lineTo(19, 6)
      break
    case 'DaemonSet': // stacked bars
      ctx.roundRect(4, 5, 16, 5, 1.5)
      ctx.roundRect(4, 14, 16, 5, 1.5)
      break
    case 'Job':
      ctx.moveTo(5, 12)
      ctx.lineTo(10, 17)
      ctx.lineTo(19, 7)
      break
    case 'CronJob':
      ctx.roundRect(4, 6, 16, 14, 2)
      ctx.moveTo(4, 10)
      ctx.lineTo(20, 10)
      ctx.moveTo(12, 13)
      ctx.lineTo(12, 16)
      ctx.lineTo(15, 16)
      break
    case 'domain': // cloud
      ctx.moveTo(7, 18)
      ctx.arc(9, 13, 4, Math.PI * 0.75, Math.PI * 1.75)
      ctx.arc(15, 12, 5, Math.PI * 1.3, Math.PI * 0.4)
      ctx.lineTo(7, 18)
      break
    case 'cidr': // range
      ctx.roundRect(3, 9, 18, 7, 2)
      ctx.moveTo(7.5, 12.5)
      ctx.lineTo(7.6, 12.5)
      ctx.moveTo(11.5, 12.5)
      ctx.lineTo(11.6, 12.5)
      ctx.moveTo(15.5, 12.5)
      ctx.lineTo(15.6, 12.5)
      break
    case 'world':
    case 'any': // asterisk
      ctx.moveTo(12, 5)
      ctx.lineTo(12, 19)
      ctx.moveTo(6, 8.5)
      ctx.lineTo(18, 15.5)
      ctx.moveTo(18, 8.5)
      ctx.lineTo(6, 15.5)
      break
    default: // Deployment, Pod, namespace: a box
      ctx.roundRect(4, 6, 16, 13, 2)
      ctx.moveTo(4, 10.5)
      ctx.lineTo(20, 10.5)
      break
  }
  ctx.stroke()
  ctx.restore()
}

export class OverlayRenderer {
  private frame = 0
  private startedAt = 0
  private nodes: OverlayNode[] = []
  private edges: OverlayEdge[] = []
  private rects: Rect[] = []
  private palette: NamespacePalette = new Map()
  private hovered: string | null = null
  private selected: string | null = null
  private animate = true

  constructor(
    private canvas: HTMLCanvasElement,
    private sigma: Sigma,
  ) {}

  setData(graph: GraphData, palette: NamespacePalette) {
    this.palette = palette
    // The kind glyph earns its place only when kinds actually differ. On a
    // namespace-level graph they never do, so it is dropped rather than repeated
    // on every card.
    const kinds = new Set(graph.nodes.filter((n) => n.kind === 'workload').map((n) => n.workloadKind))
    const showKind = kinds.size > 1

    this.nodes = graph.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      kind: n.kind,
      workloadKind: n.workloadKind,
      namespace: n.namespace,
      replicas: n.replicas,
      workloads: n.workloads,
      unprotected: n.kind === 'namespace' ? (n.unprotected ?? 0) : isUnprotected(n) ? 1 : 0,
      showKind: n.kind === 'workload' ? showKind : true,
    }))
    this.edges = graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      kind: e.kind,
      label: edgeLabel(e),
      curvature: 0.22,
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

  /** Which card, if any, is under a viewport point. Rectangles cannot be
   * hit-tested by a renderer that assumes circles, so this layer does it. */
  hitTest(x: number, y: number): string | null {
    for (let i = this.rects.length - 1; i >= 0; i--) {
      const r = this.rects[i]!
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.id
    }
    return null
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

  resize() {
    const { width, height } = this.sigma.getDimensions()
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = width * dpr
    this.canvas.height = height * dpr
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
  }

  private nodeColour(n: OverlayNode): string {
    switch (n.kind) {
      case 'namespace':
      case 'workload':
        return oklch(0.72, 0.15, hueFor(this.palette, n.namespace ?? n.label))
      case 'domain':
        return paint('domain')
      case 'cidr':
        return paint('cidr')
      default:
        return paint('world')
    }
  }

  private draw(elapsed: number) {
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)

    const positions = new Map<string, { x: number; y: number }>()
    for (const n of this.nodes) {
      const display = this.sigma.getNodeDisplayData(n.id)
      if (!display) continue
      positions.set(n.id, this.sigma.framedGraphToViewport(display))
    }

    this.drawFlow(ctx, positions, elapsed)
    this.drawEdgeLabels(ctx, positions)
    this.drawCards(ctx, positions)
  }

  private drawFlow(
    ctx: CanvasRenderingContext2D,
    positions: Map<string, { x: number; y: number }>,
    elapsed: number,
  ) {
    if (!this.animate) return

    for (const edge of this.edges) {
      if (this.hovered) {
        if (edge.source !== this.hovered && edge.target !== this.hovered) continue
      }
      const from = positions.get(edge.source)
      const to = positions.get(edge.target)
      if (!from || !to) continue

      const span = Math.hypot(to.x - from.x, to.y - from.y)
      if (span < 40) continue

      const [cx, cy] = controlPoint(from.x, from.y, to.x, to.y, edge.curvature)
      const style = FLOW_STYLES[edge.kind]
      const colour = edgeColor({ kind: edge.kind } as GraphEdge)
      const phase = (elapsed * style.speed) % 1

      for (let i = 0; i < style.particles; i++) {
        const t = (phase + i / style.particles) % 1
        const [px, py] = pointOnCurve(t, from.x, from.y, cx, cy, to.x, to.y)
        const fade = Math.sin(t * Math.PI)

        ctx.globalAlpha = (0.2 + fade * 0.8) * style.alpha
        ctx.beginPath()
        ctx.arc(px, py, style.radius, 0, Math.PI * 2)
        ctx.fillStyle = colour
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
  }

  /**
   * Edge labels are drawn here rather than by Sigma.
   *
   * Sigma decides which edge labels to show from which *node* labels it is
   * showing, and this design has no node labels — the card draws the name. Owning
   * the pass removes that coupling and puts the port text exactly on the curve's
   * midpoint, on a backing plate so it stays readable where it crosses a line.
   */
  private drawEdgeLabels(
    ctx: CanvasRenderingContext2D,
    positions: Map<string, { x: number; y: number }>,
  ) {
    const ratio = this.sigma.getCamera().getState().ratio
    const scale = Math.min(1.1, Math.max(0.5, 0.85 / Math.sqrt(ratio)))
    if (scale < 0.62) return // unreadable, and at this zoom the shape is the point

    const size = Math.round(10.5 * scale)
    ctx.font = `500 ${size}px ui-monospace, SFMono-Regular, monospace`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'

    for (const edge of this.edges) {
      if (!edge.label) continue
      if (this.hovered && edge.source !== this.hovered && edge.target !== this.hovered) continue

      const from = positions.get(edge.source)
      const to = positions.get(edge.target)
      if (!from || !to) continue
      if (Math.hypot(to.x - from.x, to.y - from.y) < 70) continue

      const [cx, cy] = controlPoint(from.x, from.y, to.x, to.y, edge.curvature)
      const [x, y] = pointOnCurve(0.5, from.x, from.y, cx, cy, to.x, to.y)

      const w = ctx.measureText(edge.label).width + 10 * scale
      const h = size + 7 * scale

      ctx.globalAlpha = 0.92
      ctx.beginPath()
      ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2)
      ctx.fillStyle = paint('canvas')
      ctx.fill()
      ctx.globalAlpha = 1

      ctx.fillStyle = edgeColor({ kind: edge.kind } as GraphEdge)
      ctx.fillText(edge.label, x, y + 0.5)
    }
    ctx.textAlign = 'left'
  }

  private drawCards(ctx: CanvasRenderingContext2D, positions: Map<string, { x: number; y: number }>) {
    const ratio = this.sigma.getCamera().getState().ratio
    // Cards shrink as you zoom out, but only so far: past the floor they would
    // be illegible, so they become dots and the graph reads as structure.
    const scale = Math.min(1.15, Math.max(0.4, 0.85 / Math.sqrt(ratio)))
    const dots = scale < DOT_SCALE

    this.rects = []

    const fg = paint('fg')
    const muted = paint('muted')
    const plate = paint('plate')
    const plateEdge = paint('plateEdge')
    const danger = paint('danger')
    const accent = paint('accent')

    for (const n of this.nodes) {
      const pos = positions.get(n.id)
      if (!pos) continue

      const colour = this.nodeColour(n)
      const dimmed = this.hovered !== null && this.hovered !== n.id && !this.isNeighbour(n.id)

      if (dots) {
        ctx.globalAlpha = dimmed ? 0.25 : 1
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, 5 * Math.max(scale, 0.5) + (n.kind === 'namespace' ? 2 : 0), 0, Math.PI * 2)
        ctx.fillStyle = n.unprotected > 0 ? danger : colour
        ctx.fill()
        ctx.globalAlpha = 1
        this.rects.push({ id: n.id, x: pos.x - 9, y: pos.y - 9, w: 18, h: 18 })
        continue
      }

      const h = Math.round(30 * scale)
      const fontSize = Math.round(12.5 * scale)
      const pad = Math.round(9 * scale)
      const glyph = Math.round(15 * scale)
      const accentW = Math.round(3.5 * scale)

      ctx.font = `500 ${fontSize}px 'Inter var', ui-sans-serif, system-ui, sans-serif`
      const label = truncate(n.label)
      const textW = ctx.measureText(label).width

      const count = n.kind === 'namespace' ? n.workloads : n.replicas
      const countText = count && count > 1 ? String(count) : ''
      ctx.font = `600 ${Math.round(10.5 * scale)}px 'Inter var', ui-sans-serif, sans-serif`
      const countW = countText ? ctx.measureText(countText).width + Math.round(10 * scale) : 0

      const glyphW = n.showKind ? glyph + pad * 0.6 : 0
      const w = Math.round(accentW + pad + glyphW + textW + countW + pad)
      const x = Math.round(pos.x - w / 2)
      const y = Math.round(pos.y - h / 2)
      const radius = Math.round(8 * scale)

      this.rects.push({ id: n.id, x, y, w, h })

      ctx.globalAlpha = dimmed ? 0.3 : 1

      // Plate
      ctx.beginPath()
      ctx.roundRect(x, y, w, h, radius)
      ctx.fillStyle = plate
      ctx.fill()

      // A colour bar on the leading edge rather than a ring around everything:
      // it identifies the namespace without shouting, and leaves the border free
      // to mean something.
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(x, y, w, h, radius)
      ctx.clip()
      ctx.fillStyle = n.unprotected > 0 ? danger : colour
      ctx.fillRect(x, y, accentW, h)
      ctx.restore()

      ctx.lineWidth = 1
      ctx.strokeStyle =
        this.selected === n.id ? accent : n.unprotected > 0 ? danger : plateEdge
      ctx.beginPath()
      ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, radius)
      ctx.stroke()

      let cursor = x + accentW + pad

      if (n.showKind) {
        ctx.strokeStyle = muted
        drawGlyph(ctx, n.workloadKind ?? n.kind, cursor + glyph / 2, pos.y, glyph)
        cursor += glyph + pad * 0.6
      }

      ctx.font = `500 ${fontSize}px 'Inter var', ui-sans-serif, system-ui, sans-serif`
      ctx.fillStyle = fg
      ctx.textBaseline = 'middle'
      ctx.fillText(label, cursor, pos.y + 0.5)

      if (countText) {
        const bw = countW - Math.round(4 * scale)
        const bx = x + w - pad - bw + Math.round(2 * scale)
        const bh = Math.round(16 * scale)
        ctx.beginPath()
        ctx.roundRect(bx, pos.y - bh / 2, bw, bh, bh / 2)
        ctx.fillStyle = plateEdge
        ctx.fill()
        ctx.font = `600 ${Math.round(10.5 * scale)}px 'Inter var', ui-sans-serif, sans-serif`
        ctx.fillStyle = muted
        ctx.textAlign = 'center'
        ctx.fillText(countText, bx + bw / 2, pos.y + 0.5)
        ctx.textAlign = 'left'
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
