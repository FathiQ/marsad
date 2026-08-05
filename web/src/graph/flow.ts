import type Sigma from 'sigma'

import type { GraphEdge } from '../api'
import { edgeColor } from './style'

/**
 * Animated flow along permitted paths.
 *
 * An important honesty constraint shapes this: Marsad reads *declared policy*,
 * never observed traffic. Particles moving along an edge would ordinarily mean
 * "packets are flowing here", and that is not something Marsad knows. So the
 * animation represents a path being *permitted*, the UI calls it that, and it is
 * only ever drawn on edges an explicit rule allows — never on the grey
 * allowed-by-default ones, where animating would imply activity through a hole
 * nobody opened deliberately.
 *
 * Drawn on a canvas above Sigma's own rather than as a WebGL edge program: the
 * particle count is small, the geometry has to match Sigma's curved edges
 * exactly, and a 2D overlay can be redrawn on demand without touching the
 * renderer's state.
 */

const PARTICLES_PER_EDGE = 3
const SPEED = 0.00022 // progress per millisecond
const PARTICLE_RADIUS = 2.1

export interface FlowEdge {
  id: string
  source: string
  target: string
  kind: GraphEdge['kind']
  curvature: number
}

/**
 * Quadratic bezier matching @sigma/edge-curve's control point: the midpoint,
 * displaced perpendicular to the chord by curvature × chord length. If this
 * drifts from Sigma's own maths the particles slide off their edges, so it is
 * kept deliberately simple and in one place.
 */
function controlPoint(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  curvature: number,
): [number, number] {
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2
  const dx = x2 - x1
  const dy = y2 - y1
  return [mx + dy * curvature, my - dx * curvature]
}

function pointOnCurve(
  t: number,
  x1: number,
  y1: number,
  cx: number,
  cy: number,
  x2: number,
  y2: number,
): [number, number] {
  const u = 1 - t
  return [
    u * u * x1 + 2 * u * t * cx + t * t * x2,
    u * u * y1 + 2 * u * t * cy + t * t * y2,
  ]
}

export class FlowRenderer {
  private frame = 0
  private start = 0
  private edges: FlowEdge[] = []
  private highlight: Set<string> | null = null

  constructor(
    private canvas: HTMLCanvasElement,
    private sigma: Sigma,
  ) {}

  setEdges(edges: FlowEdge[]) {
    // Only explicitly allowed paths animate. See the note at the top of the file.
    this.edges = edges.filter((e) => e.kind !== 'default')
  }

  /** Restricts the animation to a subset — used so hovering a node animates only
   * what that node can reach, which is the question a viewer is actually asking. */
  setHighlight(ids: Set<string> | null) {
    this.highlight = ids
  }

  start_() {
    if (this.frame) return
    this.start = performance.now()
    const loop = (now: number) => {
      this.draw(now - this.start)
      this.frame = requestAnimationFrame(loop)
    }
    this.frame = requestAnimationFrame(loop)
  }

  stop() {
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = 0
    this.clear()
  }

  private clear() {
    const ctx = this.canvas.getContext('2d')
    if (ctx) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  resize() {
    const { width, height } = this.sigma.getDimensions()
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = width * dpr
    this.canvas.height = height * dpr
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
  }

  private draw(elapsed: number) {
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)

    const graph = this.sigma.getGraph()

    for (const edge of this.edges) {
      if (this.highlight && !this.highlight.has(edge.id)) continue
      if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue

      const s = this.sigma.getNodeDisplayData(edge.source)
      const t = this.sigma.getNodeDisplayData(edge.target)
      if (!s || !t) continue

      const from = this.sigma.framedGraphToViewport(s)
      const to = this.sigma.framedGraphToViewport(t)
      const [cx, cy] = controlPoint(from.x, from.y, to.x, to.y, edge.curvature)

      // Skip edges shorter than the particle spacing: dots piled on one another
      // read as a smudge rather than as movement.
      const span = Math.hypot(to.x - from.x, to.y - from.y)
      if (span < 24) continue

      const colour = edgeColor({ kind: edge.kind } as GraphEdge)
      const phase = (elapsed * SPEED) % 1

      for (let i = 0; i < PARTICLES_PER_EDGE; i++) {
        const t0 = (phase + i / PARTICLES_PER_EDGE) % 1
        const [px, py] = pointOnCurve(t0, from.x, from.y, cx, cy, to.x, to.y)

        // Fade in and out at the ends so particles emerge from the source and
        // dissolve into the target rather than blinking on and off.
        const fade = Math.sin(t0 * Math.PI)
        ctx.globalAlpha = 0.25 + fade * 0.75

        ctx.beginPath()
        ctx.arc(px, py, PARTICLE_RADIUS, 0, Math.PI * 2)
        ctx.fillStyle = colour
        ctx.fill()

        ctx.globalAlpha = (0.1 + fade * 0.3) * 0.6
        ctx.beginPath()
        ctx.arc(px, py, PARTICLE_RADIUS * 2.6, 0, Math.PI * 2)
        ctx.fillStyle = colour
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
  }
}
