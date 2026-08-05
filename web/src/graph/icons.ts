import lucide from './lucide-icons.json'

/**
 * Node icons.
 *
 * Drawn from Lucide (ISC), recoloured white so the renderer can tint them, and
 * used as masks rather than as artwork. Two earlier attempts were wrong in
 * instructive ways:
 *
 * Hand-drawn glyphs were badly proportioned and read as amateur next to the
 * rest of the interface. A maintained set solves that for free.
 *
 * The official Kubernetes icons were tried next and are the most *recognisable*
 * option, but they are filled artwork carrying their own blue background shape.
 * Rendered on a node they swamp it: the namespace colour disappears and, far
 * worse, so does the red ring marking a workload no policy protects. Losing the
 * one signal a viewer must never miss is too high a price for familiarity.
 *
 * Line icons used as a mask keep both — the shape says what the thing is, the
 * disc and ring say whose it is and whether it is exposed.
 */

const ICONS: Record<string, string> = Object.fromEntries(
  Object.entries(lucide as Record<string, string>).map(([key, svg]) => [
    key,
    `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
  ]),
)

export function iconFor(kind: string, workloadKind?: string): string {
  switch (kind) {
    case 'namespace':
      return ICONS.Namespace!
    case 'workload':
      return ICONS[workloadKind ?? ''] ?? ICONS.Pod!
    case 'domain':
      return ICONS.domain!
    case 'cidr':
      return ICONS.cidr!
    case 'world':
      return ICONS.world!
    case 'any':
      return ICONS.any!
    default:
      return ICONS.Pod!
  }
}
