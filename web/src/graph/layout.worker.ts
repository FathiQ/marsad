/// <reference lib="webworker" />
import dagre from '@dagrejs/dagre'

/**
 * Layered left-to-right layout.
 *
 * Force-directed was the wrong choice and it showed: it produces a hairball
 * where every edge crosses every other, and no amount of node styling rescues
 * that. Policy is directional — sources reach destinations — so a layered layout
 * puts callers on the left and callees on the right and the picture becomes
 * readable on its own.
 *
 * Dagre needs each node's real dimensions to reserve space, so the caller
 * measures the cards on the main thread (text metrics need a canvas) and passes
 * them in. Running the layout here keeps a large graph from freezing the canvas.
 */

export interface LayoutNode {
  id: string
  width: number
  height: number
  /** Nodes sharing a group are kept together, so a namespace stays contiguous
   * rather than being scattered across the diagram. */
  group?: string
}

export interface LayoutRequest {
  nodes: LayoutNode[]
  edges: { source: string; target: string }[]
}

export type LayoutResult = Record<string, { x: number; y: number }>

/* Grid packing for nodes no edge touches. See packOrphans. */
const GAP_X = 34
const GAP_Y = 34
const BLOCK_GAP = 96
const ASPECT = 16 / 9

/**
 * Place nodes that no edge touches.
 *
 * Dagre ranks by edges, so every edgeless node lands in rank 0 and they come
 * back as one column with an x-span of exactly zero. That is not a rare shape:
 * a namespace whose workloads no policy selects has no edges at all — Marsad
 * draws that openness on the card rather than as edges to a hub — so any
 * namespace without policies renders as a column as tall as its workload count,
 * which the camera can only frame by zooming out until the cards are dots.
 *
 * A grid uses the horizontal space the column wastes and keeps the graph
 * roughly the shape of a viewport. Each group gets its own block so the
 * namespace boxes drawn around them stay rectangular and do not overlap.
 */
function packOrphans(
  orphans: LayoutNode[],
  origin: { x: number; y: number },
): LayoutResult {
  const byGroup = new Map<string, LayoutNode[]>()
  for (const n of orphans) {
    const key = n.group ?? ''
    const list = byGroup.get(key)
    if (list) list.push(n)
    else byGroup.set(key, [n])
  }

  const blocks = [...byGroup.values()].map((members) => {
    const cellW = Math.max(...members.map((m) => m.width)) + GAP_X
    const cellH = Math.max(...members.map((m) => m.height)) + GAP_Y
    // Solve cols so the block comes out roughly ASPECT wide-to-tall:
    // (cols * cellW) / ((count / cols) * cellH) = ASPECT.
    const cols = Math.max(
      1,
      Math.min(members.length, Math.round(Math.sqrt((ASPECT * members.length * cellH) / cellW))),
    )
    const rows = Math.ceil(members.length / cols)
    return { members, cellW, cellH, cols, width: cols * cellW, height: rows * cellH }
  })

  // Flow the blocks into rows, wrapping at a width that keeps the whole orphan
  // region near ASPECT rather than letting it run off in one direction.
  const area = blocks.reduce((sum, b) => sum + b.width * b.height, 0)
  const rowLimit = Math.max(...blocks.map((b) => b.width), Math.sqrt(area * ASPECT))

  const result: LayoutResult = {}
  let cursorX = 0
  let cursorY = 0
  let rowHeight = 0

  for (const block of blocks) {
    if (cursorX > 0 && cursorX + block.width > rowLimit) {
      cursorX = 0
      cursorY += rowHeight + BLOCK_GAP
      rowHeight = 0
    }
    block.members.forEach((node, i) => {
      const col = i % block.cols
      const row = Math.floor(i / block.cols)
      result[node.id] = {
        // Cell centres: dagre reports centres too, so both halves agree.
        x: origin.x + cursorX + col * block.cellW + block.cellW / 2,
        y: origin.y + cursorY + row * block.cellH + block.cellH / 2,
      }
    })
    cursorX += block.width + BLOCK_GAP
    rowHeight = Math.max(rowHeight, block.height)
  }

  return result
}

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const { nodes, edges } = event.data
  const post = (result: LayoutResult) => (self as unknown as Worker).postMessage(result)

  if (nodes.length === 0) {
    post({})
    return
  }

  const present = new Set(nodes.map((n) => n.id))
  const touched = new Set<string>()
  for (const e of edges) {
    // Mirrors the filter the dagre pass applies below, so a node is only called
    // connected if an edge dagre will actually rank it by survives.
    if (!present.has(e.source) || !present.has(e.target) || e.source === e.target) continue
    touched.add(e.source)
    touched.add(e.target)
  }

  const connected = nodes.filter((n) => touched.has(n.id))
  const orphans = nodes.filter((n) => !touched.has(n.id))

  if (connected.length === 0) {
    post(packOrphans(orphans, { x: 0, y: 0 }))
    return
  }

  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true })
  g.setGraph({
    rankdir: 'LR',
    // Generous separation: cards are wide, and the whole point of the layered
    // layout is that edges have room to be followed.
    nodesep: 34,
    ranksep: 130,
    edgesep: 18,
    marginx: 60,
    marginy: 60,
    ranker: 'network-simplex',
  })
  g.setDefaultEdgeLabel(() => ({}))

  const groups = new Set<string>()
  for (const n of connected) {
    if (n.group) groups.add(n.group)
  }
  for (const group of groups) {
    g.setNode(`__group__${group}`, {})
  }

  for (const n of connected) {
    g.setNode(n.id, { width: n.width, height: n.height })
    if (n.group) g.setParent(n.id, `__group__${n.group}`)
  }

  let index = 0
  for (const e of edges) {
    if (!g.hasNode(e.source) || !g.hasNode(e.target)) continue
    if (e.source === e.target) continue
    g.setEdge(e.source, e.target, {}, `e${index++}`)
  }

  dagre.layout(g)

  const result: LayoutResult = {}
  let minX = Infinity
  let maxY = -Infinity
  for (const n of connected) {
    const laid = g.node(n.id) as { x?: number; y?: number } | undefined
    if (laid && typeof laid.x === 'number' && typeof laid.y === 'number') {
      result[n.id] = { x: laid.x, y: laid.y }
      minX = Math.min(minX, laid.x - n.width / 2)
      maxY = Math.max(maxY, laid.y + n.height / 2)
    }
  }

  // The orphan grid sits under the ranked graph, left-aligned with it, rather
  // than beside it: the layered part grows sideways, so keeping both in one
  // column of the picture is what keeps the whole thing near a viewport shape.
  if (orphans.length > 0 && Number.isFinite(minX)) {
    Object.assign(result, packOrphans(orphans, { x: minX, y: maxY + BLOCK_GAP }))
  } else if (orphans.length > 0) {
    Object.assign(result, packOrphans(orphans, { x: 0, y: 0 }))
  }

  post(result)
}
