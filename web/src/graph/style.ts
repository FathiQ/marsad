import type { GraphEdge, GraphNode } from '../api'

/** Reads a CSS custom property, so the palette lives in one place and the theme
 * toggle repaints the canvas along with the chrome. */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'
}

/* ------------------------------------------------------------------ colour */

/**
 * Namespace colours, assigned by position in the sorted namespace list.
 *
 * Hashing a name to a hue is the obvious approach and it is the wrong one: two
 * namespaces collide by chance and become indistinguishable, which is exactly
 * what happened to prod and edge here — at twelve buckets and again at
 * twenty-four. Hashing optimises for a colour that is stable across clusters,
 * but what a viewer actually needs is that the namespaces on their screen differ
 * from each other.
 *
 * Assigning by position guarantees that neighbours in the list never share a
 * hue. The cost is that adding a namespace can shift the colours after it; for
 * a set that changes rarely, that is a good trade.
 */
const HUES = [205, 152, 275, 32, 340, 188, 96, 250, 14, 168, 300, 60]

export type NamespacePalette = Map<string, number>

export function buildNamespacePalette(names: string[]): NamespacePalette {
  const sorted = [...new Set(names)].sort()
  return new Map(sorted.map((name, i) => [name, HUES[i % HUES.length]!]))
}

/** Falls back to a neutral hue for a namespace the palette has not seen, which
 * happens briefly while a new namespace is still propagating. */
export function hueFor(palette: NamespacePalette, name: string): number {
  return palette.get(name) ?? 210
}

/** The swatch colour, shared by the sidebar so filter and canvas agree. */
export function namespaceSwatch(palette: NamespacePalette, name: string): string {
  return hsl(hueFor(palette, name), 58, isLight() ? 47 : 60)
}

/** True when the document is in the light theme. */
function isLight(): boolean {
  return document.documentElement.dataset.theme === 'light'
}

/**
 * HSL to hex.
 *
 * Sigma's WebGL colour parser understands hex and rgb() but not hsl(), and it
 * fails silently to black rather than erroring — which is exactly the kind of
 * bug that reads as a design choice. Hues are far easier to reason about for a
 * generated palette, so they are authored in HSL and converted here.
 */
function hsl(h: number, s: number, l: number): string {
  const sat = s / 100
  const lig = l / 100
  const chroma = (1 - Math.abs(2 * lig - 1)) * sat
  const hp = (((h % 360) + 360) % 360) / 60
  const x = chroma * (1 - Math.abs((hp % 2) - 1))
  const [r1, g1, b1] =
    hp < 1
      ? [chroma, x, 0]
      : hp < 2
        ? [x, chroma, 0]
        : hp < 3
          ? [0, chroma, x]
          : hp < 4
            ? [0, x, chroma]
            : hp < 5
              ? [x, 0, chroma]
              : [chroma, 0, x]
  const m = lig - chroma / 2
  const channel = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(r1!)}${channel(g1!)}${channel(b1!)}`
}

/**
 * Node fill. Cluster nodes take their namespace's hue so that everything
 * belonging together reads as belonging together, which is the single most
 * useful thing colour can do on this graph. External peers keep fixed,
 * deliberately non-namespace colours.
 */
export function nodeColor(node: GraphNode, palette: NamespacePalette): string {
  const light = isLight()
  switch (node.kind) {
    case 'namespace':
    case 'workload': {
      const hue = hueFor(palette, node.namespace ?? node.label)
      return node.kind === 'namespace'
        ? hsl(hue, light ? 64 : 62, light ? 47 : 58)
        : hsl(hue, light ? 54 : 50, light ? 57 : 66)
    }
    case 'world':
    case 'any':
      return cssVar('--node-world')
    case 'domain':
      return cssVar('--node-domain')
    case 'cidr':
      return cssVar('--node-cidr')
    default:
      return cssVar('--text-dim')
  }
}

/**
 * The ring around a node.
 *
 * Red means no policy selects the workload at all — the one thing a viewer
 * should be able to spot without reading a single label. Otherwise the ring is
 * a darker shade of the fill, which gives the node an edge against the
 * background instead of leaving it a flat disc.
 */
export function nodeBorderColor(node: GraphNode, palette: NamespacePalette): string {
  if (isUnprotected(node)) return cssVar('--danger')
  if (node.kind === 'namespace' || node.kind === 'workload') {
    const hue = hueFor(palette, node.namespace ?? node.label)
    return hsl(hue, isLight() ? 60 : 55, isLight() ? 33 : 28)
  }
  return cssVar('--bg')
}

/** Size carries meaning: a namespace grows with what it holds, so the busiest
 * parts of the cluster are the ones that draw the eye. */
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
      return cssVar('--allowed')
    case 'approximate':
      return cssVar('--approx')
    default:
      return cssVar('--default')
  }
}

export function edgeSize(edge: GraphEdge): number {
  // Traffic permitted only by the absence of policy is drawn thin. It is the
  // lack of a decision and should not compete with a rule somebody wrote.
  if (edge.kind === 'default') return 1
  return edge.dns ? 1.6 : 2.6
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

/** Dimmed variant used when hover isolates a neighbourhood. Keeping a trace of
 * the original colour reads better than flattening everything to grey. */
export function dimmed(light: boolean): string {
  return light ? 'rgba(140,150,165,0.16)' : 'rgba(110,120,140,0.14)'
}
