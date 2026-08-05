import type { GraphEdge, GraphNode } from '../api'

/** Reads a CSS custom property so the palette lives in one place and the theme
 * toggle changes the canvas as well as the chrome. */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'
}

export function nodeColor(node: GraphNode): string {
  switch (node.kind) {
    case 'namespace':
      return cssVar('--node-namespace')
    case 'workload':
      return cssVar('--node-workload')
    case 'world':
      return cssVar('--node-world')
    case 'any':
      return cssVar('--node-any')
    case 'domain':
      return cssVar('--node-domain')
    case 'cidr':
      return cssVar('--node-cidr')
    default:
      return cssVar('--text-dim')
  }
}

/**
 * Node size carries meaning: a namespace grows with the number of workloads it
 * holds, so the busiest parts of the cluster are the ones that draw the eye.
 */
export function nodeSize(node: GraphNode): number {
  if (node.kind === 'namespace') {
    return 8 + Math.min(16, Math.sqrt(Math.max(node.workloads ?? 0, 1)) * 3)
  }
  if (node.kind === 'workload') {
    return 6 + Math.min(8, Math.sqrt(Math.max(node.replicas ?? 1, 1)) * 1.6)
  }
  return 9
}

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
  // An edge permitted only by the absence of policy is drawn thin and grey. It
  // is the lack of a decision, and it should not compete visually with a rule
  // somebody actually wrote.
  return edge.kind === 'default' ? 0.8 : 2
}

/** Edge label: ports, or nothing when the rule places no restriction. */
export function edgeLabel(edge: GraphEdge): string {
  if (edge.kind === 'default') return ''
  if (!edge.ports?.length) return 'all ports'
  const shown = edge.ports.slice(0, 3).join(' ')
  return edge.ports.length > 3 ? `${shown} +${edge.ports.length - 3}` : shown
}

/** A node's risk posture, used for the halo and the sidebar counts. */
export function isUnprotected(node: GraphNode): boolean {
  if (node.kind === 'namespace') return (node.unprotected ?? 0) > 0
  if (node.kind === 'workload') return node.isolation ? !node.isolation.ingress && !node.isolation.egress : false
  return false
}
