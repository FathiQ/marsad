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
  /** The rules that produced this edge. Clicking through to them is the point.
   * Always an array from a correct server — an allowed-by-default edge has none
   * — but treated as optional here so a contract violation degrades instead of
   * blanking the page. */
  via?: string[]
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
  /** The build this Marsad came from. Always present; "dev" for an unstamped
   * binary. Optional here only so an older server does not break the UI. */
  version?: string
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

/** One clause of a podSelector a workload fails, and what it has instead. */
export interface MissedRequirement {
  /** The clause as a human reads it: "app=web", "tier in (edge, dmz)". */
  text: string
  key: string
  /** The workload's value for `key`. Absent and empty are different situations,
   * which `present` distinguishes: one is a typo in the policy, the other a
   * typo in the workload. */
  value?: string
  present: boolean
}

/** A policy that did not select this workload, and the clauses that stopped it. */
export interface Miss {
  policy: ObjectRef
  provider: string
  types: string
  selector: string
  missed?: MissedRequirement[]
  /** How many clauses the workload does satisfy, which is what makes one miss
   * nearer than another. */
  matched: number
}

/** Where a rule identifier came from, resolved by the server so the UI never
 * has to take the identifier apart. */
export interface RuleRef {
  policy: ObjectRef
  provider: string
  path: string
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
  /** Every rule identifier in the effective sets above, mapped to the policy
   * responsible for it. */
  rules?: Record<string, RuleRef>
  /** Policies in this namespace that did not select the workload, nearest
   * first. What the "nothing selects this" state exists to answer. */
  closestMisses?: Miss[]
}

/** One half of a simulation: what the source's egress says, or what the
 * destination's ingress says. `not-applicable` means the endpoint is not a
 * workload, so no policy of that direction governs it. */
export type SimResult = 'not-applicable' | 'allowed' | 'denied' | 'undecidable'

export type SimReason =
  | ''
  | 'not-isolated'
  | 'matched-rule'
  | 'no-matching-rule'
  | 'no-policy-selects'
  | 'unknown-workload'
  | 'domain-resolution'

export interface Decision {
  result: SimResult
  reason: SimReason
  via?: string[]
  explain: string
  /** Each provider's own answer. With the layers combined by intersection, a
   * connection can be refused by one provider while another permits it, and
   * knowing which is what makes the denial actionable. */
  byLayer?: Record<string, SimResult>
}

/** A connection needs the source's egress and the destination's ingress to both
 * permit it. Both halves are always reported, because checking only one is the
 * usual way reading policy by hand goes wrong. */
export interface Verdict {
  allowed: boolean
  undecidable: boolean
  egress: Decision
  ingress: Decision
  summary: string
}

/** Exactly one of these identifies an endpoint. */
export interface SimEndpoint {
  namespace?: string
  name?: string
  kind?: string
  cidr?: string
  domain?: string
}

export interface SimQuery {
  from: SimEndpoint
  to: SimEndpoint
  protocol: string
  port: number
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

/**
 * Asks whether a connection would be permitted by declared policy.
 *
 * POST only because the query is a structured object — it reads the in-memory
 * snapshot and changes nothing, in a tool with no write path at all.
 */
export async function simulate(q: SimQuery): Promise<Verdict> {
  const res = await fetch('/api/simulate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(q),
  })
  if (res.status === 503) throw new NotReadyError('cluster state is still syncing')
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  }
  return (await res.json()) as Verdict
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
