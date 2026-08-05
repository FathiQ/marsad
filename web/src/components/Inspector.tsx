import { AnimatePresence, motion } from 'motion/react'
import { ArrowRight, ChevronRight, FileCode2, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import {
  fetchWorkload,
  type Allow,
  type Effective,
  type GraphEdge,
  type GraphNode,
  type PortRange,
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h3 className="text-[10.5px] font-semibold tracking-[0.07em] text-faint uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}

/** One allow entry, including the rules behind it. That trace is the feature the
 * whole tool exists for, so it is never collapsed away. */
function AllowCard({ allow }: { allow: Allow }) {
  return (
    <div className="rounded-lg border border-line bg-bg p-3">
      <p className="text-[12.5px] font-medium break-words text-fg">{allow.peer.display}</p>
      <p className="mt-1 font-mono text-[11px] text-muted">{portText(allow.ports)}</p>
      {allow.note && (
        <p className="mt-2 border-l-2 border-warn/40 pl-2.5 text-[11.5px] leading-relaxed text-warn">
          {allow.note}
        </p>
      )}
      <div className="mt-2.5 space-y-1 border-t border-dashed border-line pt-2.5">
        {allow.via.map((v) => (
          <code key={v} className="block font-mono text-[10.5px] break-all text-faint">
            {v}
          </code>
        ))}
      </div>
    </div>
  )
}

function EffectiveSection({ title, eff }: { title: string; eff: Effective }) {
  if (!eff.isolated) {
    return (
      <Section title={title}>
        <p className="text-[12.5px] text-faint">
          No policy applies {title.toLowerCase()} rules here, so everything is allowed by default.
        </p>
      </Section>
    )
  }

  return (
    <Section title={title}>
      {(eff.allows?.length ?? 0) === 0 ? (
        <p className="text-[12.5px] text-faint">
          Isolated with no matching rules — all {title.toLowerCase()} denied.
        </p>
      ) : (
        <div className="space-y-2">
          {eff.allows?.map((a, i) => <AllowCard key={i} allow={a} />)}
        </div>
      )}

      {/* Layers are shown separately whenever more than one provider governs the
          workload: the combined view is an interpretation, the per-provider
          truth is not. */}
      {(eff.layers?.length ?? 0) > 1 && (
        <details className="group rounded-lg border border-line bg-bg">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[12px] text-muted">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
            Per-provider layers ({eff.layers?.length})
          </summary>
          <div className="space-y-3 border-t border-line p-3">
            {eff.layers?.map((l) => (
              <div key={l.provider} className="space-y-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="accent">{l.provider}</Badge>
                  <span className="text-[11px] text-faint">
                    {l.by?.map((b) => b.name).join(', ')}
                  </span>
                </div>
                {l.allows?.map((a, i) => <AllowCard key={i} allow={a} />)}
              </div>
            ))}
          </div>
        </details>
      )}
    </Section>
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
          <dt className="text-faint">Ports</dt>
          <dd className="font-mono text-[11.5px] text-muted">
            {edge.ports?.length ? edge.ports.join(', ') : 'all ports'}
          </dd>
          <dt className="text-faint">Kind</dt>
          <dd>
            {edge.kind === 'allowed' && <Badge tone="ok">explicitly allowed</Badge>}
            {edge.kind === 'default' && <Badge>allowed by default</Badge>}
            {edge.kind === 'approximate' && <Badge tone="warn">approximate</Badge>}
          </dd>
        </dl>

        {edge.note && (
          <p className="border-l-2 border-warn/40 pl-2.5 text-[11.5px] leading-relaxed text-warn">
            {edge.note}
          </p>
        )}
      </Section>

      <Section title="Produced by">
        {!edge.via?.length ? (
          <p className="text-[12.5px] text-faint">
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

function WorkloadBody({ detail }: { detail: WorkloadDetail }) {
  const { workload, isolation, policies } = detail
  return (
    <div className="space-y-6">
      <Section title="Posture">
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={isolation.ingress ? 'ok' : 'danger'}>
            ingress {isolation.ingress ? 'isolated' : 'open'}
          </Badge>
          <Badge tone={isolation.egress ? 'ok' : 'danger'}>
            egress {isolation.egress ? 'isolated' : 'open'}
          </Badge>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
          <dt className="text-faint">Kind</dt>
          <dd className="text-muted">{workload.kind}</dd>
          <dt className="text-faint">Replicas</dt>
          <dd className="num text-muted">{workload.replicas}</dd>
          {workload.ports?.length ? (
            <>
              <dt className="text-faint">Ports</dt>
              <dd className="font-mono text-[11.5px] text-muted">
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
                className="rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-[10.5px] text-muted"
              >
                {k}={v}
              </code>
            ))}
          </div>
        )}
      </Section>

      <Separator />
      <EffectiveSection title="Ingress" eff={detail.ingress} />
      <Separator />
      <EffectiveSection title="Egress" eff={detail.egress} />
      <Separator />

      <Section title={`Applied policies (${policies?.length ?? 0})`}>
        {!policies?.length ? (
          <p className="text-[12.5px] text-faint">
            No policy selects this workload. It is reachable from anywhere and can reach anywhere.
          </p>
        ) : (
          <div className="space-y-2">
            {policies.map((p) => (
              <details
                key={`${p.ref.namespace}/${p.ref.name}/${p.provider}`}
                className="group overflow-hidden rounded-lg border border-line bg-bg"
              >
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 hover:bg-elevated">
                  <ChevronRight className="size-3.5 shrink-0 text-faint transition-transform group-open:rotate-90" />
                  <FileCode2 className="size-3.5 shrink-0 text-faint" />
                  <span className="flex-1 truncate text-[12.5px] font-medium text-fg">
                    {p.ref.name}
                  </span>
                  <Badge>{p.types}</Badge>
                </summary>
                {/* Read-only viewer: Marsad never writes, and the drawer should
                    not look like somewhere you could. */}
                <pre className="max-h-80 overflow-auto border-t border-line bg-canvas p-3 font-mono text-[10.5px] leading-relaxed text-muted">
                  {p.yaml ?? '# original object unavailable'}
                </pre>
              </details>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

export function Inspector({ node, edge, nodesById, onClose }: Props) {
  const [detail, setDetail] = useState<WorkloadDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setDetail(null)
    setError(null)
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

  const open = Boolean(node || edge)
  const title = edge ? 'Connection' : (node?.label ?? '')
  const subtitle = edge
    ? 'click-through to the rules behind it'
    : [node?.namespace, node?.workloadKind ?? node?.kind].filter(Boolean).join(' · ')

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
              <p className="mt-0.5 truncate text-[11.5px] text-faint">{subtitle}</p>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close details">
              <X />
            </Button>
          </header>

          <ScrollArea className="flex-1">
            <div className="p-4 pb-10">
              {edge && <EdgeBody edge={edge} nodesById={nodesById} />}

              {node && !edge && (
                <>
                  {loading && <p className="text-[12.5px] text-faint">Loading…</p>}
                  {error && <p className="text-[12.5px] text-danger">{error}</p>}
                  {detail && <WorkloadBody detail={detail} />}

                  {node.kind === 'namespace' && (
                    <Section title="Namespace">
                      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
                        <dt className="text-faint">Workloads</dt>
                        <dd className="num text-muted">{node.workloads ?? 0}</dd>
                        <dt className="text-faint">Unprotected</dt>
                        <dd
                          className={cn(
                            'num',
                            (node.unprotected ?? 0) > 0 ? 'text-danger' : 'text-muted',
                          )}
                        >
                          {node.unprotected ?? 0}
                        </dd>
                      </dl>
                      <p className="text-[12.5px] text-faint">
                        Switch to workload level, or select this namespace, to expand it.
                      </p>
                    </Section>
                  )}

                  {['cidr', 'world', 'domain', 'any'].includes(node.kind) && (
                    <Section title="External peer">
                      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
                        <dt className="text-faint">Kind</dt>
                        <dd className="text-muted">{node.kind}</dd>
                        <dt className="text-faint">Value</dt>
                        <dd className="font-mono text-[11.5px] break-all text-muted">
                          {node.label}
                        </dd>
                      </dl>
                      <p className="text-[12.5px] text-faint">
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
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
