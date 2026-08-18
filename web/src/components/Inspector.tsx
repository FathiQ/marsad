import { AnimatePresence, motion } from 'motion/react'
import {
  ArrowRight,
  ChevronRight,
  FileCode2,
  Route,
  SearchX,
  ShieldOff,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  fetchWorkload,
  type Allow,
  type Effective,
  type GraphEdge,
  type GraphNode,
  type Miss,
  type PortRange,
  type RuleRef,
  type WorkloadDetail,
} from '../api'
import { cn } from '../lib/cn'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { ScrollArea } from './ui/scroll-area'
import { Separator } from './ui/separator'

interface Props {
  node: GraphNode | null
  edge: GraphEdge | null
  nodesById: Map<string, GraphNode>
  onClose: () => void
  /** Opens the simulate panel already framed by whatever is selected. */
  onSimulate: () => void
}

function portText(ports?: PortRange[]): string {
  if (!ports?.length) return 'all ports'
  return ports
    .map((p) => {
      if (p.allPorts) return `*/${p.protocol}`
      const range = p.to && p.to !== p.from ? `${p.from}-${p.to}` : `${p.from}`
      return p.name ? `${p.name}=${range}/${p.protocol}` : `${range}/${p.protocol}`
    })
    .join(', ')
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2.5">
      <div>
        <h3 className="text-[10.5px] font-semibold tracking-[0.07em] text-text-dim uppercase">
          {title}
        </h3>
        {subtitle && <div className="mt-1 text-[11.5px] text-muted">{subtitle}</div>}
      </div>
      {children}
    </section>
  )
}

/** `netpol` / `anp` rather than the group name: it is the word people use. */
function ProviderBadge({ provider }: { provider: string }) {
  return (
    <Badge tone="neutral" className="font-mono">
      {provider === 'aws-anp' ? 'anp' : 'netpol'}
    </Badge>
  )
}

/**
 * One effective rule.
 *
 * The port and the peer are the rule; the policy that decided it is the
 * traceability the whole tool exists for, so it is a named chip rather than the
 * raw rule identifier this used to print. Identifiers like
 * "networking.k8s.io/NetworkPolicy/prod/api-allow#ingress[0]" are precise and
 * unreadable, and the precision is only needed once you have already found the
 * policy.
 */
function RuleCard({
  allow,
  rules,
  onOpenPolicy,
}: {
  allow: Allow
  rules: Record<string, RuleRef>
  onOpenPolicy: (key: string) => void
}) {
  // One rule can be produced by several policies; each gets its own chip.
  const deciding = new Map<string, RuleRef>()
  for (const id of allow.via ?? []) {
    const ref = rules[id]
    if (ref) deciding.set(`${ref.policy.namespace}/${ref.policy.name}/${ref.provider}`, ref)
  }

  return (
    <div className="rounded-lg border border-line bg-bg p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-[12px] text-fg">{portText(allow.ports)}</span>
        <ArrowRight className="size-3 shrink-0 self-center text-text-dim" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-[12.5px] break-words text-text-body">
          {allow.peer.display}
        </span>
      </div>

      {/* B2: an approximate rule carries its reason where the rule is, not in a
          footnote. The evaluator writes the sentence; it knows which of the
          several undecidable shapes this one is. */}
      {allow.note && (
        <p className="mt-2 border-l-2 border-approx/50 pl-2.5 text-[11.5px] leading-relaxed text-approx-text">
          {allow.note}
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-dashed border-line pt-2.5">
        <span className="text-[10.5px] text-text-dim">decided by</span>
        {deciding.size === 0 ? (
          <span className="text-[11px] text-text-dim">no rule — Kubernetes default</span>
        ) : (
          [...deciding.entries()].map(([key, ref]) => (
            <button
              key={key}
              onClick={() => onOpenPolicy(key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5',
                'font-mono text-[11px] text-accent transition-colors hover:bg-accent/20',
                'outline-none focus-visible:ring-2 focus-visible:ring-accent/70',
              )}
              // An explicit name, not the bare text: "api-ingress" alone tells a
              // screen reader nothing about what activating it does, and the
              // same name appears again in the policy list below.
              aria-label={`Show the YAML of ${ref.policy.name}`}
            >
              {ref.policy.name}
              <FileCode2 className="size-3" aria-hidden="true" />
            </button>
          ))
        )}
      </div>
    </div>
  )
}

/**
 * What the absence of a policy permits, written in the same shape as a rule.
 *
 * "Everything, from anywhere, on every port" is not the absence of an answer —
 * it is a permission as real as any rule, and the only difference is that
 * nobody wrote it down.
 */
function ExposureCard({ direction }: { direction: 'ingress' | 'egress' }) {
  return (
    <div className="rounded-lg border border-danger/40 bg-danger/5 p-3">
      <p className="flex items-baseline gap-2 text-[12.5px] font-medium text-danger">
        <span aria-hidden="true">{direction === 'ingress' ? '↙' : '↗'}</span>
        <span className="font-mono">any port</span>
        <span className="font-normal">
          {direction === 'ingress' ? 'from anywhere' : 'to anywhere'}
        </span>
      </p>
      <p className="mt-2.5 border-t border-dashed border-danger/25 pt-2.5 text-[11px] text-muted">
        decided by: <span className="text-danger">no rule — Kubernetes default</span>
      </p>
    </div>
  )
}

/**
 * One direction, as a question about traffic rather than a policy field name.
 *
 * "Ingress" and "Egress" are what the API calls them; ACCEPTS and REACHES are
 * what they do, and which one a reader wants is never in doubt when they are
 * named that way round.
 */
function DirectionSection({
  eff,
  direction,
  isolatedBy,
  rules,
  onOpenPolicy,
}: {
  eff: Effective
  direction: 'ingress' | 'egress'
  isolatedBy: number
  rules: Record<string, RuleRef>
  onOpenPolicy: (key: string) => void
}) {
  const title = direction === 'ingress' ? 'Accepts' : 'Reaches'
  const label = direction === 'ingress' ? 'Ingress' : 'Egress'

  const subtitle = eff.isolated ? (
    <>
      <span className="text-text-body">{label} — isolated</span>
      <span className="px-1.5 opacity-50">·</span>
      <span className="num">{isolatedBy}</span>{' '}
      {isolatedBy === 1 ? 'policy selects it' : 'policies select it'}
    </>
  ) : (
    <span className="text-danger">{label} — not isolated</span>
  )

  return (
    <Section title={title} subtitle={subtitle}>
      {!eff.isolated ? (
        <ExposureCard direction={direction} />
      ) : (eff.allows?.length ?? 0) === 0 ? (
        <p className="rounded-lg border border-dashed border-line bg-bg px-3 py-4 text-center text-[12px] text-muted">
          Isolated with no matching rules — all {direction} denied.
        </p>
      ) : (
        <div className="space-y-2">
          {eff.allows?.map((a, i) => (
            <RuleCard key={i} allow={a} rules={rules} onOpenPolicy={onOpenPolicy} />
          ))}
        </div>
      )}

      {/* Layers are shown separately whenever more than one provider governs the
          workload: the combined view is an interpretation, the per-provider
          truth is not. */}
      {(eff.layers?.length ?? 0) > 1 && (
        <details className="group rounded-lg border border-line bg-bg">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[12px] text-muted">
            <ChevronRight className="size-3.5 text-line-faint transition-transform group-open:rotate-90" />
            Per-provider layers ({eff.layers?.length})
          </summary>
          <div className="space-y-3 border-t border-line p-3">
            {eff.layers?.map((l) => (
              <div key={l.provider} className="space-y-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="accent">{l.provider}</Badge>
                  <span className="text-[11px] text-text-dim">
                    {l.by?.map((b) => b.name).join(', ')}
                  </span>
                </div>
                {l.allows?.map((a, i) => (
                  <RuleCard key={i} allow={a} rules={rules} onOpenPolicy={onOpenPolicy} />
                ))}
              </div>
            ))}
          </div>
        </details>
      )}
    </Section>
  )
}

/**
 * The policies that nearly selected this workload.
 *
 * This is the answer to the question the empty state provokes and used to
 * leave hanging. "No policy selects this" states a fact; the thing anybody
 * actually wants to know next is which policy was *supposed* to, and answering
 * that by hand means opening every policy in the namespace and comparing
 * selectors by eye. It is nearly always one label, and nearly always obvious
 * the moment the two are put side by side.
 */
function ClosestMisses({ misses, labels }: { misses: Miss[]; labels?: Record<string, string> }) {
  const shown = misses.slice(0, 5)

  return (
    <div className="space-y-2">
      <p className="text-[11.5px] leading-relaxed text-muted">
        {misses.length === 1
          ? 'One policy in this namespace came close:'
          : `${misses.length} policies in this namespace came close. The nearest:`}
      </p>

      {shown.map((miss) => (
        <div
          key={`${miss.policy.namespace}/${miss.policy.name}/${miss.provider}`}
          className="rounded-lg border border-line bg-bg p-3"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <ProviderBadge provider={miss.provider} />
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">
              {miss.policy.name}
            </span>
            <span className="text-[10.5px] text-text-dim">{miss.types}</span>
          </div>

          {/* Suppressed when the selector *is* the failed clause. Printing both
              says the same thing twice a line apart, and the two renderings
              space their commas differently, which reads as a bug rather than
              as emphasis. */}
          {!(miss.matched === 0 && miss.missed?.length === 1) && (
            <p className="mt-2 text-[11.5px] text-muted">
              selects <span className="font-mono text-text-body">{miss.selector}</span>
            </p>
          )}

          {/* The half of the answer that is about the pod, not the policy. */}
          {miss.missed?.map((m) => (
            <p key={m.text} className="mt-1.5 text-[11.5px] text-text-dim">
              <span className="font-mono text-approx-text">{m.text}</span>
              {' — '}
              {m.present ? (
                <>
                  this workload has{' '}
                  <span className="font-mono text-text-body">
                    {m.key}={m.value}
                  </span>
                </>
              ) : (
                <>
                  this workload has no{' '}
                  <span className="font-mono text-text-body">{m.key}</span> label
                </>
              )}
            </p>
          ))}
        </div>
      ))}

      {misses.length > shown.length && (
        <p className="text-[11px] text-text-dim">
          and {misses.length - shown.length} more, further away.
        </p>
      )}

      {labels && Object.keys(labels).length === 0 && (
        <p className="text-[11.5px] leading-relaxed text-muted">
          This workload has no labels at all, so only a policy with an empty
          <span className="font-mono"> podSelector </span>
          could ever select it.
        </p>
      )}
    </div>
  )
}

function EdgeBody({ edge, nodesById }: { edge: GraphEdge; nodesById: Map<string, GraphNode> }) {
  const source = nodesById.get(edge.source)
  const target = nodesById.get(edge.target)

  return (
    <div className="space-y-6">
      <Section title="Traffic">
        {/* From and to, stated as a direction rather than as two rows: which way
            the traffic goes is half the meaning of a policy edge. */}
        <div className="flex items-center gap-2.5 rounded-lg border border-line bg-bg p-3">
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg">
            {source?.label ?? edge.source}
          </span>
          <ArrowRight className="size-4 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate text-right text-[12.5px] font-medium text-fg">
            {target?.label ?? edge.target}
          </span>
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
          <dt className="text-text-dim">Ports</dt>
          <dd className="font-mono text-[11.5px] text-text-body">
            {edge.ports?.length ? edge.ports.join(', ') : 'all ports'}
          </dd>
          <dt className="text-text-dim">Kind</dt>
          <dd>
            {edge.kind === 'allowed' && <Badge tone="ok">explicitly allowed</Badge>}
            {edge.kind === 'default' && <Badge>allowed by default</Badge>}
            {edge.kind === 'approximate' && <Badge tone="warn">approximate</Badge>}
          </dd>
        </dl>

        {edge.note && (
          <p className="border-l-2 border-approx/50 pl-2.5 text-[11.5px] leading-relaxed text-approx-text">
            {edge.note}
          </p>
        )}
      </Section>

      <Section title="Produced by">
        {!edge.via?.length ? (
          <p className="text-[12.5px] text-muted">
            Nothing produced this edge — it exists because no policy isolates the workload.
          </p>
        ) : (
          <div className="space-y-1 rounded-lg border border-line bg-bg p-3">
            {edge.via?.map((v) => (
              <code key={v} className="block font-mono text-[10.5px] break-all text-muted">
                {v}
              </code>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

function WorkloadBody({
  detail,
  openPolicy,
  onOpenPolicy,
}: {
  detail: WorkloadDetail
  openPolicy: string | null
  onOpenPolicy: (key: string) => void
}) {
  const { workload, isolation, policies } = detail
  const rules = detail.rules ?? {}
  const misses = detail.closestMisses ?? []
  const unprotected = !isolation.ingress && !isolation.egress

  return (
    <div className="space-y-6">
      {unprotected && (
        <div className="flex gap-2.5 rounded-lg border border-danger/40 bg-danger/10 p-3">
          <ShieldOff className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-[12.5px] font-semibold text-danger">
              No policy selects this workload, so Kubernetes allows everything to and from it
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
              Every port, from any source in the cluster or outside it, and out to anywhere. This is
              the default, not a decision — nothing has been written down about this workload at
              all.
            </p>
          </div>
        </div>
      )}

      <Section title="Workload">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
          <dt className="text-text-dim">Kind</dt>
          <dd className="text-text-body">{workload.kind}</dd>
          <dt className="text-text-dim">Replicas</dt>
          <dd className="num text-text-body">{workload.replicas}</dd>
          {workload.ports?.length ? (
            <>
              <dt className="text-text-dim">Ports</dt>
              <dd className="font-mono text-[11.5px] text-text-body">
                {workload.ports.map((p) => `${p.name}=${p.port}/${p.protocol}`).join(', ')}
              </dd>
            </>
          ) : null}
        </dl>
        {workload.labels && Object.keys(workload.labels).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(workload.labels).map(([k, v]) => (
              <code
                key={k}
                className="rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-[10.5px] text-text-body"
              >
                {k}={v}
              </code>
            ))}
          </div>
        )}
      </Section>

      <Separator />
      <DirectionSection
        eff={detail.ingress}
        direction="ingress"
        isolatedBy={isolation.ingressBy?.length ?? 0}
        rules={rules}
        onOpenPolicy={onOpenPolicy}
      />
      <Separator />
      <DirectionSection
        eff={detail.egress}
        direction="egress"
        isolatedBy={isolation.egressBy?.length ?? 0}
        rules={rules}
        onOpenPolicy={onOpenPolicy}
      />
      <Separator />

      <Section title={`Applied policies (${policies?.length ?? 0})`}>
        {!policies?.length ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-dashed border-line bg-bg px-3 py-5 text-center">
              <SearchX className="mx-auto size-5 text-text-dim" aria-hidden="true" />
              <p className="mt-2 text-[12.5px] font-medium text-fg">
                Nothing selects this workload
              </p>
              <p className="mx-auto mt-1 max-w-[38ch] text-[11.5px] leading-relaxed text-muted">
                No NetworkPolicy or ApplicationNetworkPolicy has a{' '}
                <code className="font-mono text-[11px]">podSelector</code> matching its labels, in
                either direction.
              </p>
            </div>

            {misses.length > 0 && (
              <ClosestMisses misses={misses} labels={workload.labels} />
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {policies.map((p) => {
              const key = `${p.ref.namespace}/${p.ref.name}/${p.provider}`
              return (
                <details
                  key={key}
                  id={`policy-${key}`}
                  open={openPolicy === key}
                  className="group overflow-hidden rounded-lg border border-line bg-bg"
                >
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 hover:bg-elevated">
                    <ChevronRight className="size-3.5 shrink-0 text-line-faint transition-transform group-open:rotate-90" />
                    <ProviderBadge provider={p.provider} />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">
                      {p.ref.name}
                    </span>
                    <span className="shrink-0 text-[10.5px] text-text-dim">{p.types}</span>
                  </summary>
                  {/* Read-only viewer: Marsad never writes, and the drawer should
                      not look like somewhere you could. */}
                  <pre className="max-h-80 overflow-auto border-t border-line bg-canvas p-3 font-mono text-[10.5px] leading-relaxed text-text-body">
                    {p.yaml ?? '# original object unavailable'}
                  </pre>
                </details>
              )
            })}
          </div>
        )}
      </Section>
    </div>
  )
}

export function Inspector({ node, edge, nodesById, onClose, onSimulate }: Props) {
  const [detail, setDetail] = useState<WorkloadDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [openPolicy, setOpenPolicy] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setDetail(null)
    setError(null)
    setOpenPolicy(null)
    if (!node || node.kind !== 'workload' || !node.namespace) return

    let cancelled = false
    setLoading(true)
    fetchWorkload(node.namespace, node.label, node.workloadKind)
      .then((d) => !cancelled && setDetail(d))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [node])

  // Following a rule to its policy has to land somewhere visible; the policy
  // list is usually below the fold by the time anyone gets there.
  const openPolicyAndScroll = (key: string) => {
    setOpenPolicy(key)
    requestAnimationFrame(() => {
      const el = scroller.current?.querySelector(`#policy-${CSS.escape(key)}`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }

  const open = Boolean(node || edge)
  const title = edge ? 'Connection' : (node?.label ?? '')
  const subtitle = edge
    ? 'the rules behind it'
    : [node?.namespace, node?.workloadKind ?? node?.kind].filter(Boolean).join(' · ')
  const isWorkload = node?.kind === 'workload'

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          role="dialog"
          aria-label="Details"
          initial={{ x: 24, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 24, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 420, damping: 38 }}
          className={cn(
            'absolute inset-y-0 right-0 z-20 flex w-[min(34rem,64vw)] flex-col',
            'border-l border-line bg-surface shadow-2xl',
          )}
        >
          <header className="flex items-start gap-3 border-b border-line px-4 py-3.5">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[15px] font-semibold tracking-tight">{title}</h2>
              <p className="mt-0.5 truncate text-[11.5px] text-text-dim">{subtitle}</p>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close details">
              <X />
            </Button>
          </header>

          <ScrollArea className="flex-1" viewportRef={scroller}>
            <div className="p-4 pb-10">
              {edge && <EdgeBody edge={edge} nodesById={nodesById} />}

              {node && !edge && (
                <>
                  {loading && (
                    <div className="space-y-3" aria-busy="true">
                      <div className="h-4 w-1/3 animate-pulse rounded bg-elevated" />
                      <div className="h-20 animate-pulse rounded-lg bg-elevated" />
                      <div className="h-20 animate-pulse rounded-lg bg-elevated" />
                    </div>
                  )}
                  {error && <p className="text-[12.5px] text-danger">{error}</p>}
                  {detail && (
                    <WorkloadBody
                      detail={detail}
                      openPolicy={openPolicy}
                      onOpenPolicy={openPolicyAndScroll}
                    />
                  )}

                  {node.kind === 'namespace' && (
                    <Section title="Namespace">
                      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
                        <dt className="text-text-dim">Workloads</dt>
                        <dd className="num text-text-body">{node.workloads ?? 0}</dd>
                        <dt className="text-text-dim">Unprotected</dt>
                        <dd
                          className={cn(
                            'num',
                            (node.unprotected ?? 0) > 0 ? 'text-danger' : 'text-text-body',
                          )}
                        >
                          {node.unprotected ?? 0}
                        </dd>
                      </dl>
                      <p className="text-[12.5px] text-muted">
                        Switch to workload level, or select this namespace, to expand it.
                      </p>
                    </Section>
                  )}

                  {['cidr', 'world', 'domain', 'any'].includes(node.kind) && (
                    <Section title="External peer">
                      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
                        <dt className="text-text-dim">Kind</dt>
                        <dd className="text-text-body">{node.kind}</dd>
                        <dt className="text-text-dim">Value</dt>
                        <dd className="font-mono text-[11.5px] break-all text-text-body">
                          {node.label}
                        </dd>
                      </dl>
                      <p className="text-[12.5px] text-muted">
                        {node.kind === 'any'
                          ? 'Matched by rules with no from/to list — literally anything, in or out of the cluster.'
                          : 'Click an edge touching this node to see which rule allows it.'}
                      </p>
                    </Section>
                  )}
                </>
              )}
            </div>
          </ScrollArea>

          {/* One primary action. The panel answers "what can reach this"; the
              question it most often raises next is "and would this specific
              connection work", which is a different tool one click away. */}
          {isWorkload && (
            <div className="shrink-0 border-t border-line bg-panel px-4 py-3">
              <Button variant="default" size="md" className="w-full gap-2" onClick={onSimulate}>
                <Route />
                Simulate from {node?.label}
              </Button>
            </div>
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
