import type { GraphEdge, GraphNode } from '../api'

/**
 * The canvas palette, read from the CSS tokens rather than restated here.
 *
 * This used to be a hand-converted second copy of the `:root` table, because
 * Sigma's WebGL colour parser understands hex and rgb() only — it does not
 * understand oklch(), and it falls back to black *silently* rather than
 * erroring, which reads as a design choice rather than a bug.
 *
 * The copy is what let `--node-world` and `--danger` drift into being the same
 * colour in two files at once: fixing one file would have left the canvas — the
 * only place world nodes are actually drawn — still wrong. So styles.css is
 * authored in hex now, and this reads it. One table, one place to change it,
 * and the WCAG test in internal/theme governs what the canvas paints too.
 */
const CANVAS_TOKENS = {
  fg: '--fg',
  muted: '--muted',
  faint: '--faint',
  canvas: '--canvas',
  accent: '--accent',
  allowed: '--allowed',
  neutralEdge: '--neutral-edge',
  approx: '--approx',
  danger: '--danger',
  domain: '--node-domain',
  cidr: '--node-cidr',
  world: '--node-world',
  picto: '--picto',
  plate: '--card-plate',
  plateEdge: '--line-strong',
} as const

export type CanvasColour = keyof typeof CANVAS_TOKENS

/**
 * The canvas font stacks, matching --font-sans and --font-mono in styles.css.
 *
 * Restated rather than read, because a Canvas2D `font` string is parsed by the
 * CSS font shorthand grammar and cannot take a var(). They must stay in step
 * with the tokens: card widths are measured with one of these strings and drawn
 * with another, so a mismatch is a layout bug, not a cosmetic one.
 */
export const SANS_STACK = `'Inter', ui-sans-serif, system-ui, sans-serif`
export const MONO_STACK = `'JetBrains Mono', ui-monospace, SFMono-Regular, monospace`

/**
 * Unmistakably not a design choice.
 *
 * The whole reason this file existed as a duplicate was that a colour Sigma
 * cannot parse disappears into black, which looks deliberate. If a token ever
 * fails to resolve, it should look like the bug it is.
 */
const UNRESOLVED = '#ff00ff'

let cache: Record<CanvasColour, string> | null = null
let cachedFor: string | null = null

/** Which palette is live: an explicit choice, or what the OS asked for. */
function themeKey(): string {
  const chosen = document.documentElement.dataset.theme
  if (chosen === 'light' || chosen === 'dark') return chosen
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/**
 * Resolved once per theme, not per call.
 *
 * paint() sits inside the per-card and per-edge draw loops, and getComputedStyle
 * forces a style recalculation. Resolving the whole table on the first call
 * after a theme change keeps that cost to once per repaint of the graph.
 */
export function paint(name: CanvasColour): string {
  const key = themeKey()
  if (cache === null || cachedFor !== key) {
    const style = getComputedStyle(document.documentElement)
    const next = {} as Record<CanvasColour, string>
    for (const [token, property] of Object.entries(CANVAS_TOKENS)) {
      next[token as CanvasColour] = style.getPropertyValue(property).trim() || UNRESOLVED
    }
    cache = next
    cachedFor = key
  }
  return cache[name]
}

/* ------------------------------------------------------------------ colour */

/**
 * Namespace colours, assigned by position in the sorted namespace list.
 *
 * Hashing a name to a hue is the obvious approach and it is the wrong one: two
 * namespaces collide by chance and become indistinguishable, which is exactly
 * what happened to prod and edge here — at twelve buckets and again at
 * twenty-four. Hashing optimises for a colour that is stable across clusters,
 * but what a viewer needs is that the namespaces on their screen differ from
 * each other.
 *
 * Assigning by position guarantees that neighbours in the list never share a
 * hue. The cost is that adding a namespace can shift the colours after it; for
 * a set that changes rarely, that is a good trade.
 */
const HUES = [255, 155, 305, 45, 350, 195, 125, 275, 25, 175, 325, 85]

export type NamespacePalette = Map<string, number>

export function buildNamespacePalette(names: string[]): NamespacePalette {
  const sorted = [...new Set(names)].sort()
  return new Map(sorted.map((name, i) => [name, HUES[i % HUES.length]!]))
}

/** Falls back to a neutral hue for a namespace the palette has not seen yet. */
export function hueFor(palette: NamespacePalette, name: string): number {
  return palette.get(name) ?? 255
}

function isLight(): boolean {
  return themeKey() === 'light'
}

/**
 * OKLCH to hex.
 *
 * The palette is authored in OKLCH because it keeps perceived lightness even
 * across hues — the reason twelve namespace colours can sit side by side without
 * one shouting. Sigma's WebGL colour parser only understands hex and rgb(), and
 * fails silently to black rather than erroring, so the conversion happens here
 * rather than being left to the browser.
 */
export function oklch(l: number, c: number, h: number): string {
  const hr = (h * Math.PI) / 180
  const a = c * Math.cos(hr)
  const b = c * Math.sin(hr)

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b
  const s_ = l - 0.0894841775 * a - 1.291485548 * b

  const L = l_ * l_ * l_
  const M = m_ * m_ * m_
  const S = s_ * s_ * s_

  const lr = 4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S
  const lg = -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S
  const lb = -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S

  const gamma = (v: number) =>
    v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055
  const channel = (v: number) =>
    Math.round(Math.min(1, Math.max(0, gamma(v))) * 255)
      .toString(16)
      .padStart(2, '0')

  return `#${channel(lr)}${channel(lg)}${channel(lb)}`
}

/**
 * Node fill. Cluster nodes take their namespace's hue so that everything
 * belonging together reads as belonging together — the single most useful thing
 * colour can do on this graph. External peers keep fixed, non-namespace colours.
 */
/**
 * Node fill. Cluster nodes take their namespace's hue so that everything
 * belonging together reads as belonging together — the single most useful thing
 * colour can do on this graph. External peers keep fixed, non-namespace colours.
 */
export function nodeColor(node: GraphNode, palette: NamespacePalette): string {
  const light = isLight()
  switch (node.kind) {
    case 'namespace':
    case 'workload': {
      const hue = hueFor(palette, node.namespace ?? node.label)
      return node.kind === 'namespace'
        ? oklch(light ? 0.64 : 0.72, 0.15, hue)
        : oklch(light ? 0.7 : 0.78, 0.13, hue)
    }
    case 'world':
    case 'any':
      return paint('world')
    case 'domain':
      return paint('domain')
    case 'cidr':
      return paint('cidr')
    default:
      return paint('muted')
  }
}

/**
 * The ring around a node. Red means no policy selects the workload at all — the
 * one thing a viewer should spot without reading a single label.
 */
export function nodeBorderColor(node: GraphNode, palette: NamespacePalette): string {
  // Red means no policy selects the workload at all — the one signal a viewer
  // must be able to catch without reading a single label, so it overrides
  // everything else the ring might otherwise say.
  if (isUnprotected(node)) return paint('danger')
  if (node.kind === 'namespace' || node.kind === 'workload') {
    const hue = hueFor(palette, node.namespace ?? node.label)
    return oklch(isLight() ? 0.46 : 0.4, 0.11, hue)
  }
  return paint('canvas')
}

/** Size carries meaning: a namespace grows with what it holds, so the busiest
 * parts of the cluster draw the eye. */
export function nodeSize(node: GraphNode): number {
  switch (node.kind) {
    case 'namespace':
      return 22 + Math.min(26, Math.sqrt(Math.max(node.workloads ?? 0, 1)) * 4.2)
    case 'workload':
      return 17 + Math.min(12, Math.sqrt(Math.max(node.replicas ?? 1, 1)) * 2.4)
    case 'world':
    case 'any':
      return 24
    default:
      return 20
  }
}

/* ------------------------------------------------------------------- edges */

export function edgeColor(edge: GraphEdge): string {
  switch (edge.kind) {
    case 'allowed':
      return paint('allowed')
    case 'approximate':
      return paint('approx')
    default:
      return paint('neutralEdge')
  }
}

export function edgeSize(edge: GraphEdge): number {
  // Traffic permitted only by the absence of policy is drawn thin: it is the
  // lack of a decision and should not compete with a rule somebody wrote.
  if (edge.kind === 'default') return 1
  return edge.dns ? 1.8 : 3
}

/** Edge label: ports, or nothing when the rule places no restriction. */
export function edgeLabel(edge: GraphEdge): string {
  if (edge.kind === 'default') return ''
  if (edge.dns) return 'DNS'
  if (!edge.ports?.length) return 'all ports'
  const shown = edge.ports.slice(0, 2).join(' ')
  return edge.ports.length > 2 ? `${shown} +${edge.ports.length - 2}` : shown
}

/** A workload no policy selects, or a namespace holding one. */
export function isUnprotected(node: GraphNode): boolean {
  if (node.kind === 'namespace') return (node.unprotected ?? 0) > 0
  if (node.kind === 'workload') {
    return node.isolation ? !node.isolation.ingress && !node.isolation.egress : false
  }
  return false
}

/**
 * Dimming for the hover state.
 *
 * The first attempt replaced unrelated nodes with a flat grey disc and hid their
 * icons, which turned a hover into a screen full of featureless blobs — worse
 * than no dimming at all. Keeping the shape and icon and merely draining the
 * contrast preserves the picture while pushing it back.
 */
export function dimmedFill(): string {
  return isLight() ? oklch(0.95, 0.004, 265) : oklch(0.32, 0.012, 265)
}

export function dimmedRing(): string {
  return isLight() ? oklch(0.88, 0.006, 265) : oklch(0.38, 0.014, 265)
}

export function dimmedEdge(): string {
  return isLight() ? 'rgba(120,132,150,0.30)' : 'rgba(120,134,160,0.22)'
}
