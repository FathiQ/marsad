// Types mirroring the Go API. Kept hand-written rather than generated: the
// surface is small, and the field comments are where the semantics live.

export type Level = 'namespace' | 'workload'

export type NodeKind = 'namespace' | 'workload' | 'cidr' | 'world' | 'domain' | 'any'

/** Explicitly allowed, allowed only by the absence of policy, or undecidable. */
export type EdgeKind = 'allowed' | 'default' | 'approximate'

export interface Isolation {
  ingress: boolean
  egress: boolean
}

export interface GraphNode {
  id: string
  kind: NodeKind
  label: string
  namespace?: string
  workloadKind?: string
  replicas?: number
  isolation?: Isolation
  /** Namespace nodes only: how many workloads are aggregated, and how many of
   * them no policy selects at all. */
  workloads?: number
  unprotected?: number
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  kind: EdgeKind
  ports?: string[]
  /** Set when the edge carries only port 53, so DNS can be folded away. */
  dns?: boolean
  /** The rules that produced this edge. Clicking through to them is the point. */
  via: string[]
  note?: string
}

export interface Graph {
  level: Level
  namespaces?: string[]
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Peers were collapsed to keep the graph legible. Never hidden silently. */
  truncated?: boolean
}

export interface ObjectRef {
  group?: string
  kind: string
  namespace?: string
  name: string
}

export interface Capability {
  provider: string
  group: string
  resource: string
  available: boolean
  reason?: string
}

export interface Meta {
  revision: number
  builtAt: string
  capabilities: { policies: Capability[] }
  counts: { namespaces: number; workloads: number; policies: number }
  warnings: { object: string; message: string }[] | null
  combineMode: 'intersect' | 'union'
  readOnly: boolean
}

export interface NamespaceSummary {
  name: string
  workloads: number
  policies: number
  unprotected: number
}

export interface PortRange {
  protocol: string
  allPorts?: boolean
  name?: string
  from?: number
  to?: number
}

export interface ResolvedPeer {
  kind: 'any' | 'pods' | 'cidr' | 'domain' | number
  namespaces?: string[]
  workloads?: ObjectRef[]
  cidr?: string
  except?: string[]
  domain?: string
  display: string
}

export interface Allow {
  peer: ResolvedPeer
  ports?: PortRange[]
  via: string[]
  approximate?: boolean
  note?: string
}

export interface Layer {
  provider: string
  isolated: boolean
  by?: ObjectRef[]
  allows?: Allow[]
}

export interface Effective {
  workload: ObjectRef
  /** 0 = ingress, 1 = egress. A Go iota, serialised as a number. */
  direction: number
  isolated: boolean
  layers?: Layer[]
  allows?: Allow[]
}

export interface PolicyView {
  ref: ObjectRef
  provider: string
  types: string
  selector: string
  yaml?: string
}

export interface WorkloadDetail {
  workload: {
    ref: ObjectRef
    kind: string
    labels?: Record<string, string>
    replicas: number
    ports?: { name: string; port: number; protocol: string }[]
  }
  isolation: {
    ingress: boolean
    egress: boolean
    ingressBy?: ObjectRef[]
    egressBy?: ObjectRef[]
  }
  policies?: PolicyView[]
  ingress: Effective
  egress: Effective
}

/** Thrown for a 503, which means the informer caches have not synced yet. It is
 * a normal, brief startup condition and the UI shows a skeleton for it. */
export class NotReadyError extends Error {}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } })
  if (res.status === 503) throw new NotReadyError('cluster state is still syncing')
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

export const fetchMeta = () => get<Meta>('/api/meta')
export const fetchNamespaces = () => get<NamespaceSummary[]>('/api/namespaces')

export interface GraphQuery {
  level: Level
  namespaces: string[]
  includeDefault: boolean
}

export function graphParams(q: GraphQuery): string {
  const p = new URLSearchParams({ level: q.level })
  if (q.namespaces.length) p.set('namespaces', q.namespaces.join(','))
  if (!q.includeDefault) p.set('includeDefault', 'false')
  return p.toString()
}

export async function fetchGraph(q: GraphQuery): Promise<{ revision: number; graph: Graph }> {
  return get<{ revision: number; graph: Graph }>(`/api/graph?${graphParams(q)}`)
}

export function fetchWorkload(namespace: string, name: string, kind?: string) {
  const p = kind ? `?kind=${encodeURIComponent(kind)}` : ''
  return get<WorkloadDetail>(
    `/api/workloads/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}${p}`,
  )
}

export interface StreamMessage {
  type: string
  revision: number
  graph?: Graph
  warnings?: number
  error?: string
}

/**
 * Subscribes to live graph updates.
 *
 * The server pushes a whole graph rather than a diff, debounced on its side, so
 * there is no reconciliation protocol to get wrong here. Reconnects with backoff
 * because a dropped socket is routine — a rolling restart, a laptop lid.
 */
export function openStream(
  q: GraphQuery,
  onMessage: (m: StreamMessage) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  let socket: WebSocket | null = null
  let retry = 0
  let timer: number | undefined
  let closed = false

  const connect = () => {
    if (closed) return
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    socket = new WebSocket(`${proto}//${location.host}/api/stream?${graphParams(q)}`)

    socket.onopen = () => {
      retry = 0
      onStatus(true)
    }
    socket.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data as string) as StreamMessage)
      } catch {
        // A malformed frame is not worth tearing the connection down for.
      }
    }
    socket.onclose = () => {
      // A deliberately closed socket must not report offline. Changing the
      // graph query tears this stream down and opens a replacement, and the old
      // socket's close event arrives *after* the new one has already connected —
      // so reporting here overwrites a healthy status with a stale one, and
      // nothing ever sets it back. The badge then reads offline while updates
      // are arriving normally.
      if (closed) return

      onStatus(false)
      retry = Math.min(retry + 1, 6)
      timer = window.setTimeout(connect, Math.min(1000 * 2 ** retry, 30_000))
    }
    socket.onerror = () => socket?.close()
  }

  connect()

  return () => {
    closed = true
    if (timer) window.clearTimeout(timer)
    socket?.close()
  }
}
