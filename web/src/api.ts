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
  /** Something outside the cluster can reach this, following edges the way
   * traffic flows. Being able to *call* the internet is not the same thing, and
   * conflating them would mark every workload with egress as exposed. */
  exposed?: boolean
  /** A CIDR peer outside any private range. */
  public?: boolean
  /** Set on the counted stand-in for everything focus left out. */
  hidden?: boolean
  namespaces?: number
  /** A namespace collapsed because nobody asked about it. Counted and
   * expandable, not hidden. */
  system?: boolean
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

/** What a focused build drew, and what it left out. */
export interface FocusInfo {
  node: string
  hops: number
  namespaces: number
  totalNamespaces: number
  workloads: number
  totalWorkloads: number
  hidden: number
}

/** A graph that was not drawn because drawing it would be unreadable. */
export interface Oversize {
  nodes: number
  limit: number
}

export interface Graph {
  level: Level
  namespaces?: string[]
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Peers were collapsed to keep the graph legible. Never hidden silently. */
  truncated?: boolean
  focus?: FocusInfo
  oversize?: Oversize
  /** Namespaces holding no workloads. Reported rather than drawn: they have no
   * posture and would float as unconnected nodes through the middle. */
  emptyNamespaces?: string[]
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

/** One policy as the search index sees it. */
export interface PolicySummary {
  ref: ObjectRef
  provider: string
  types: string
  selector: string
  /** How many workloads its podSelector actually matches. Zero is usually label
   * drift, and protects exactly as much as no policy at all. */
  selects: number
}

export const fetchPolicies = () => get<PolicySummary[]>('/api/policies')

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
  /** Decided, but by a rule whose reach configuration alone cannot pin down —
   * a domain wildcard intersected with an address range. Deliberately not a
   * fourth `result`: the question was answered, and it is the rule's extent
   * that is approximate, not the answer. */
  approximate?: boolean
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
  /** Allowed, but leaning on a rule whose extent depends on DNS. Both this and
   * `allowed` are true in that case. */
  approximate?: boolean
}

/** One rule behind an edge: the excerpt, not the document it lives in. */
export interface RuleDetail {
  id: string
  policy: ObjectRef
  provider: string
  path: string
  /** YAML of the rule at `path` only. */
  yaml?: string
  /** Things true of this rule that are easy to read past, derived from the rule
   * itself rather than matched against a list of known-bad strings. */
  cautions?: string[]
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
  /** Node id to reduce the graph around. Empty draws everything. */
  focus?: string
  focusHops?: number
  /** System namespaces to draw in full despite the collapse. */
  expand?: string[]
  /** Draw namespaces holding no workloads. */
  includeEmpty?: boolean
}

export function graphParams(q: GraphQuery): string {
  const p = new URLSearchParams({ level: q.level })
  if (q.namespaces.length) p.set('namespaces', q.namespaces.join(','))
  if (!q.includeDefault) p.set('includeDefault', 'false')
  if (q.focus) p.set('focus', q.focus)
  if (q.focusHops) p.set('focusHops', String(q.focusHops))
  if (q.expand?.length) p.set('expand', q.expand.join(','))
  if (q.includeEmpty) p.set('includeEmpty', 'true')
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

/** Resolves the rules behind an edge, for the popover that explains it. */
export function fetchRules(ids: string[]) {
  if (ids.length === 0) return Promise.resolve<RuleDetail[]>([])
  return get<RuleDetail[]>(`/api/rules?ids=${encodeURIComponent(ids.join(','))}`)
}

export function fetchWorkload(namespace: string, name: string, kind?: string) {
  const p = kind ? `?kind=${encodeURIComponent(kind)}` : ''
  return get<WorkloadDetail>(
    `/api/workloads/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}${p}`,
  )
}

/** One line on the startup screen: a group of informers and how far it has got. */
export interface SyncStep {
  name: string
  synced: boolean
  /** What has arrived so far. Before `synced` this is a lower bound, not a
   * total, which is why the screen says "so far". */
  count: number
}

/** Why Marsad cannot read the cluster. */
export interface Fault {
  kind: 'forbidden' | 'unauthorized' | 'unreachable' | 'other'
  /** The API server's own words, not a summary of them. Every layer that
   * paraphrases this is a layer that can turn one problem into a different one,
   * and the resource and verb it named are what make it fixable. */
  message: string
  /** Marsad's reading of it, kept separate so it cannot be mistaken for
   * something the cluster said. */
  hint?: string
  host?: string
}

export interface Health {
  ok: boolean
  ready: boolean
  progress?: SyncStep[]
  fault?: Fault
  /** The ClusterRole that would answer a permission failure, ready to apply. */
  clusterRole?: string
  time: string
}

/** Answers while the caches are still filling, when everything else 503s. */
export const fetchHealth = () => get<Health>('/api/health')

export interface StreamMessage {
  type: string
  revision: number
  graph?: Graph
  warnings?: number
  error?: string
}

/**
 * How current what you are looking at is.
 *
 * A config-reading tool has no other tell. A graph rendered from a snapshot
 * taken four minutes ago looks exactly like one rendered a second ago, and the
 * difference is whether the answer is about the cluster or about its past — so
 * the state is carried explicitly rather than reduced to a boolean.
 */
export type StreamState = 'live' | 'reconnecting' | 'snapshot'

export interface StreamStatus {
  state: StreamState
  /** When the last graph arrived. Null until the first one does. */
  updatedAt: Date | null
  /** For 'reconnecting': when the next attempt is due. */
  retryAt: Date | null
  attempt: number
}

export interface StreamHandle {
  close: () => void
  /** Try again now, rather than waiting out the backoff. */
  reconnect: () => void
  /** Stop retrying and keep showing what is on screen. */
  keepSnapshot: () => void
}

/**
 * Subscribes to live graph updates.
 *
 * The server pushes a whole graph rather than a diff, debounced on its side, so
 * there is no reconciliation protocol to get wrong here. Reconnects with
 * backoff because a dropped socket is routine — a rolling restart, a laptop
 * lid — and reports which of those two situations it is in, because "offline"
 * covered both and they call for different things from the person reading it.
 */
export function openStream(
  q: GraphQuery,
  onMessage: (m: StreamMessage) => void,
  onStatus: (status: StreamStatus) => void,
): StreamHandle {
  let socket: WebSocket | null = null
  let retry = 0
  let timer: number | undefined
  let closed = false
  let giveUp = false
  let updatedAt: Date | null = null

  const report = (state: StreamState, retryAt: Date | null = null) =>
    onStatus({ state, updatedAt, retryAt, attempt: retry })

  const connect = () => {
    if (closed) return
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    socket = new WebSocket(`${proto}//${location.host}/api/stream?${graphParams(q)}`)

    socket.onopen = () => {
      retry = 0
      report('live')
    }
    socket.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data as string) as StreamMessage)
        updatedAt = new Date()
        report('live')
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
      if (giveUp) {
        report('snapshot')
        return
      }

      retry = Math.min(retry + 1, 6)
      const delay = Math.min(1000 * 2 ** retry, 30_000)
      report('reconnecting', new Date(Date.now() + delay))
      timer = window.setTimeout(connect, delay)
    }
    socket.onerror = () => socket?.close()
  }

  connect()

  return {
    close: () => {
      closed = true
      if (timer) window.clearTimeout(timer)
      socket?.close()
    },
    reconnect: () => {
      giveUp = false
      retry = 0
      if (timer) window.clearTimeout(timer)
      report('reconnecting', new Date())
      socket?.close()
      connect()
    },
    keepSnapshot: () => {
      giveUp = true
      if (timer) window.clearTimeout(timer)
      report('snapshot')
    },
  }
}
