import * as Dialog from '@radix-ui/react-dialog'
import { ArrowRight, CircleHelp, Loader2, ShieldCheck, ShieldX, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  fetchGraph,
  fetchWorkload,
  simulate,
  type Decision,
  type Effective,
  type GraphNode,
  type SimEndpoint,
  type SimResult,
  type Verdict,
} from '../api'
import { cn } from '../lib/cn'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

/** What the user typed, before it is resolved to an endpoint. */
export interface Endpoint {
  text: string
  /** Set when the text came from picking a workload out of the cluster. */
  workload?: { namespace: string; name: string; kind?: string }
}

export interface Prefill {
  from?: Endpoint
  to?: Endpoint
  port?: number
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  prefill?: Prefill
}

const CIDR = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$|^[0-9a-fA-F:]+(\/\d{1,3})?$/

/**
 * Turns what the user typed into the endpoint shape the API takes.
 *
 * A picked workload is unambiguous. Free text is not, so it is classified the
 * way a person would read it: something that parses as an address is an address,
 * and anything else is a domain. The classification is shown back to them rather
 * than applied silently.
 */
export function resolveEndpoint(ep: Endpoint): { value: SimEndpoint; label: string } | null {
  if (ep.workload) {
    return {
      value: { namespace: ep.workload.namespace, name: ep.workload.name, kind: ep.workload.kind },
      label: 'workload',
    }
  }
  const text = ep.text.trim()
  if (!text) return null
  if (CIDR.test(text) && text.includes(':') !== text.includes('.')) {
    return { value: { cidr: text }, label: 'address' }
  }
  return { value: { domain: text }, label: 'domain' }
}

interface Option {
  node: GraphNode
  display: string
}

/**
 * Kubernetes reserves the kube- prefix for its own namespaces. Offering
 * kube-proxy and kindnet ahead of somebody's own workloads is never what was
 * wanted, so they sort last rather than being hidden — a question about
 * kube-dns is a perfectly reasonable one to ask.
 */
const isSystem = (ns?: string) => Boolean(ns?.startsWith('kube-'))

function optionsFor(nodes: GraphNode[], query: string): Option[] {
  const text = query.trim().toLowerCase()
  return nodes
    .filter((n) => n.kind === 'workload' || n.kind === 'domain')
    .map((n) => ({
      node: n,
      display: n.kind === 'workload' ? `${n.namespace}/${n.label}` : n.label,
    }))
    .filter((o) => !text || o.display.toLowerCase().includes(text))
    .sort((a, b) => {
      const sys = Number(isSystem(a.node.namespace)) - Number(isSystem(b.node.namespace))
      return sys || a.display.localeCompare(b.display)
    })
    .slice(0, 60)
}

function EndpointField({
  id,
  label,
  value,
  onChange,
  nodes,
  onListOpen,
  closeSignal,
}: {
  id: string
  label: string
  value: Endpoint
  onChange: (ep: Endpoint) => void
  nodes: GraphNode[]
  onListOpen: (open: boolean) => void
  closeSignal: number
}) {
  const [openList, setOpenList] = useState(false)
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)

  const options = useMemo(() => optionsFor(nodes, value.text), [nodes, value.text])

  useEffect(() => setActive(0), [value.text])

  // The dialog needs to know, so that Escape can dismiss the list first, and
  // tells us to close when it decides that is what Escape meant.
  useEffect(() => onListOpen(openList), [openList, onListOpen])
  useEffect(() => {
    if (closeSignal) setOpenList(false)
  }, [closeSignal])

  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active, openList])

  useEffect(() => {
    if (!openList) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpenList(false)
    }
    // Deferred a tick: the click that opened the list would otherwise close it.
    const t = window.setTimeout(() => window.addEventListener('mousedown', onDown), 0)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('mousedown', onDown)
    }
  }, [openList])

  const pick = (o: Option) => {
    onChange(
      o.node.kind === 'workload'
        ? {
            text: o.display,
            workload: {
              namespace: o.node.namespace ?? '',
              name: o.node.label,
              kind: o.node.workloadKind,
            },
          }
        : { text: o.display },
    )
    setOpenList(false)
  }

  const resolved = resolveEndpoint(value)

  return (
    <div className="relative" ref={box}>
      {/* The hint shares the label's row rather than sitting over the field.
          Floated inside the input it covered the end of anything long, which is
          exactly when a domain most needs reading. */}
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[11px] font-medium text-faint">
          {label}
        </label>
        {resolved && !value.workload && (
          <span className="truncate text-[10.5px] text-faint">
            read as {/^[aeiou]/.test(resolved.label) ? 'an' : 'a'} {resolved.label}
          </span>
        )}
      </div>
      <input
        id={id}
        role="combobox"
        aria-expanded={openList}
        aria-controls={`${id}-list`}
        autoComplete="off"
        spellCheck={false}
        value={value.text}
        placeholder="namespace/workload, a domain, or an address"
        onChange={(e) => {
          onChange({ text: e.target.value })
          setOpenList(true)
        }}
        onFocus={() => setOpenList(true)}
        onKeyDown={(e) => {
          // Escape is deliberately not handled here. React flushes discrete
          // events synchronously, so closing the list from this handler would
          // re-render before Radix's own document listener runs and it would
          // see no list open — and close the whole dialog. The dialog decides,
          // in onEscapeKeyDown, and signals back.
          if (!openList || !options.length) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((i) => (i + 1) % options.length)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => (i - 1 + options.length) % options.length)
          } else if (e.key === 'Enter') {
            // Only when the highlight is being used, so typing a domain and
            // pressing enter still submits the form rather than picking a
            // workload the user never looked at.
            if (value.text.trim() && options[active]) {
              e.preventDefault()
              pick(options[active])
            }
          }
        }}
        className={cn(
          'h-9 w-full rounded-lg border border-line bg-bg px-3 text-[13px] text-fg',
          'outline-none placeholder:text-faint focus:border-accent/60',
        )}
      />
      {openList && options.length > 0 && (
        <ul
          id={`${id}-list`}
          ref={list}
          role="listbox"
          className="absolute z-20 mt-1 max-h-[13rem] w-full overflow-y-auto rounded-lg border border-line bg-elevated p-1 shadow-2xl"
        >
          {options.map((o, i) => (
            <li key={o.node.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px]',
                  i === active ? 'bg-accent/15 text-fg' : 'text-muted',
                )}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  // mousedown, not click: the outside handler fires first
                  // otherwise and the list is gone before the click lands.
                  e.preventDefault()
                  pick(o)
                }}
              >
                <span className="truncate">{o.display}</span>
                <span className="ml-auto shrink-0 text-[10.5px] text-faint">
                  {o.node.kind === 'workload' ? o.node.workloadKind : 'domain'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const TONE: Record<SimResult, { tone: 'ok' | 'danger' | 'warn' | 'neutral'; text: string }> = {
  allowed: { tone: 'ok', text: 'allowed' },
  denied: { tone: 'danger', text: 'denied' },
  undecidable: { tone: 'warn', text: 'undecidable' },
  'not-applicable': { tone: 'neutral', text: 'not applicable' },
}

/**
 * One direction's answer.
 *
 * Both halves are always shown, even when one of them settles the question,
 * because "the source may not leave" and "the destination will not accept" look
 * identical in a graph and call for edits to different policies in different
 * namespaces.
 */
function Half({
  title,
  decision,
  counterfactual,
}: {
  title: string
  decision: Decision
  /** What this half *would* accept, shown only when it is the half saying no.
   * "Denied" tells you the connection fails; this tells you what the policy was
   * written for, which is usually the difference between a fix and a guess. */
  counterfactual?: string[]
}) {
  const tone = TONE[decision.result] ?? TONE['not-applicable']
  const layers = Object.entries(decision.byLayer ?? {})
  // The server's sentence already names the rules it matched; repeating them
  // underneath is noise. Checked by containment rather than by parsing the
  // prose, so the list simply comes back if that ever stops being true.
  const via = decision.via?.filter((v) => !decision.explain.includes(v)) ?? []

  return (
    <section
      className={cn(
        'rounded-xl border p-3.5',
        decision.result === 'denied' ? 'border-danger/40 bg-danger/5' : 'border-line bg-bg',
      )}
    >
      <header className="flex items-center justify-between gap-2">
        <h4 className="text-[10.5px] font-semibold tracking-[0.07em] text-faint uppercase">
          {title}
        </h4>
        <Badge tone={tone.tone}>{tone.text}</Badge>
      </header>

      <p className="mt-2 text-[12.5px] leading-relaxed break-words text-muted">{decision.explain}</p>

      {layers.length > 1 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {layers.map(([provider, result]) => (
            <Badge key={provider} tone={TONE[result]?.tone ?? 'neutral'}>
              {provider} · {TONE[result]?.text ?? result}
            </Badge>
          ))}
        </div>
      )}

      {decision.approximate && (
        <p className="mt-2 border-l-2 border-approx/50 pl-2.5 text-[11.5px] leading-relaxed text-approx-text">
          Permitted, but the rule that permits it names a domain — which
          addresses that covers is a runtime fact Marsad does not observe.
        </p>
      )}

      {decision.result === 'denied' && counterfactual && counterfactual.length > 0 && (
        <div className="mt-2.5 border-t border-dashed border-line pt-2.5">
          <p className="text-[10.5px] tracking-[0.06em] text-text-dim uppercase">
            What it does accept
          </p>
          <ul className="mt-1.5 space-y-1">
            {counterfactual.map((line) => (
              <li key={line} className="font-mono text-[11px] break-words text-text-body">
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      {via.length > 0 && (
        <div className="mt-2.5 space-y-1 border-t border-dashed border-line pt-2.5">
          {via.map((v) => (
            <code key={v} className="block font-mono text-[10.5px] break-all text-text-dim">
              {v}
            </code>
          ))}
        </div>
      )}
    </section>
  )
}

/** The four states, with the current one lit. */
const SCALE = ['Allowed', 'Denied', 'Approximate', 'Undecidable'] as const
type ScaleState = (typeof SCALE)[number]

function stateOf(verdict: Verdict): ScaleState {
  if (verdict.undecidable) return 'Undecidable'
  if (!verdict.allowed) return 'Denied'
  return verdict.approximate ? 'Approximate' : 'Allowed'
}

const TONE_OF: Record<ScaleState, 'ok' | 'danger' | 'warn'> = {
  Allowed: 'ok',
  Denied: 'danger',
  Approximate: 'warn',
  Undecidable: 'warn',
}

/**
 * What the verdict *means*, as opposed to what it is called.
 *
 * "Denied" is a label; "the source may leave, the destination will not accept"
 * is the finding, and it is what decides which policy in which namespace
 * somebody has to go and edit. The two halves look identical in a graph and
 * call for entirely different work.
 */
function implication(verdict: Verdict): string {
  const leaves = verdict.egress.result
  const accepts = verdict.ingress.result

  if (verdict.undecidable) {
    return 'One half depends on what a domain name resolves to at runtime, which Marsad does not observe.'
  }
  if (verdict.allowed) {
    const base = 'The source may leave. The destination will accept.'
    return verdict.approximate
      ? base + ' Both permit it, but one leans on a rule whose reach depends on DNS.'
      : base
  }

  const half = (result: string, may: string, mayNot: string) =>
    result === 'denied' ? mayNot : may

  return [
    half(leaves, 'The source may leave.', 'The source may not leave.'),
    half(accepts, 'The destination will accept.', 'The destination will not accept.'),
  ].join(' ')
}

function Headline({ verdict }: { verdict: Verdict }) {
  const state = stateOf(verdict)
  const tone = TONE_OF[state]
  const Icon =
    state === 'Allowed' ? ShieldCheck : state === 'Denied' ? ShieldX : CircleHelp

  return (
    <div className="space-y-2.5">
      <div
        className={cn(
          'flex items-start gap-3 rounded-xl border p-3.5',
          tone === 'ok' && 'border-allowed/40 bg-allowed/10',
          tone === 'danger' && 'border-danger/40 bg-danger/10',
          tone === 'warn' && 'border-warn/40 bg-warn/10',
        )}
      >
        <Icon
          className={cn(
            'mt-0.5 size-5 shrink-0',
            tone === 'ok' && 'text-allowed-text',
            tone === 'danger' && 'text-danger',
            tone === 'warn' && 'text-approx-text',
          )}
        />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'text-[14px] font-semibold',
              tone === 'ok' && 'text-allowed-text',
              tone === 'danger' && 'text-danger',
              tone === 'warn' && 'text-approx-text',
            )}
          >
            {state === 'Undecidable' ? 'Cannot be decided' : state}
          </p>
          <p className="mt-0.5 text-[12.5px] leading-relaxed break-words text-text-body">
            {implication(verdict)}
          </p>
          <p className="mt-1 font-mono text-[11px] leading-relaxed break-words text-text-dim">
            {verdict.summary.replace(/^(ALLOWED|DENIED|UNDECIDABLE): /, '')}
          </p>
        </div>
      </div>

      {/* The scale, so the answer is read against the alternatives it was
          chosen from rather than in isolation. Undecidable in particular means
          nothing until you can see it is not the same kind of thing as Denied. */}
      <ol
        aria-label="Verdict scale"
        className="flex items-center gap-1 rounded-lg border border-line bg-bg p-1"
      >
        {SCALE.map((s) => {
          const current = s === state
          return (
            <li
              key={s}
              aria-current={current ? 'true' : undefined}
              className={cn(
                'flex-1 rounded-md px-2 py-1 text-center text-[11px] transition-colors',
                !current && 'text-text-dim',
                current && TONE_OF[s] === 'ok' && 'bg-allowed/15 font-semibold text-allowed-text',
                current && TONE_OF[s] === 'danger' && 'bg-danger/15 font-semibold text-danger',
                current && TONE_OF[s] === 'warn' && 'bg-approx/15 font-semibold text-approx-text',
              )}
            >
              {s}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

const blank: Endpoint = { text: '' }

export function SimulatePanel({ open, onOpenChange, prefill }: Props) {
  // The panel needs workloads whatever the graph is currently showing, and at
  // namespace level the graph has none. Fetched once on first open rather than
  // held by the app, so a panel nobody opens costs nothing.
  const [nodes, setNodes] = useState<GraphNode[]>([])
  useEffect(() => {
    if (!open || nodes.length) return
    let cancelled = false
    fetchGraph({ level: 'workload', namespaces: [], includeDefault: true })
      .then((r) => !cancelled && setNodes(r.graph.nodes))
      .catch(() => {
        // Only the autocomplete is lost; the fields still take free text.
      })
    return () => {
      cancelled = true
    }
  }, [open, nodes.length])

  // Which fields have a suggestion list showing. Escape belongs to the list
  // when one is open and to the dialog otherwise. Held in a ref because Radix
  // reads this from a document-level listener during the keystroke itself, and
  // rendered state would already have moved on.
  const listsOpen = useRef<Record<string, boolean>>({})
  const [closeLists, setCloseLists] = useState(0)
  const noteList = useCallback(
    (id: string) => (open: boolean) => {
      listsOpen.current[id] = open
    },
    [],
  )
  const fromList = useMemo(() => noteList('from'), [noteList])
  const toList = useMemo(() => noteList('to'), [noteList])

  const [from, setFrom] = useState<Endpoint>(blank)
  const [to, setTo] = useState<Endpoint>(blank)
  const [protocol, setProtocol] = useState('TCP')
  const [port, setPort] = useState('443')
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  // Reset on open rather than on close, so the previous answer does not flash
  // away while the dialog is still animating out.
  useEffect(() => {
    if (!open) return
    setFrom(prefill?.from ?? blank)
    setTo(prefill?.to ?? blank)
    if (prefill?.port) setPort(String(prefill.port))
    setVerdict(null)
    setError(null)
  }, [open, prefill])

  const fromEP = resolveEndpoint(from)
  const toEP = resolveEndpoint(to)

  /*
   * What the refusing half *does* accept.
   *
   * A denial tells you the connection fails. It does not tell you what the
   * policy was written for, and without that the next step is a guess — the
   * commonest guess being that the rule is missing entirely, when in fact it
   * exists and names a different peer or a different port. Read from the same
   * evaluation the graph draws, so it cannot disagree with the panel above it.
   */
  const [accepts, setAccepts] = useState<{ egress: string[]; ingress: string[] }>({
    egress: [],
    ingress: [],
  })

  useEffect(() => {
    if (!verdict) {
      setAccepts({ egress: [], ingress: [] })
      return
    }

    const lines = (eff: Effective | undefined, preposition: string) =>
      (eff?.allows ?? []).slice(0, 4).map((a) => {
        const ports = a.ports?.length
          ? a.ports
              .map((pr) =>
                pr.allPorts ? `*/${pr.protocol}` : `${pr.from ?? '?'}/${pr.protocol}`,
              )
              .join(', ')
          : 'any port'
        return `${ports} ${preposition} ${a.peer.display}`
      })

    let cancelled = false
    const load = async () => {
      const next = { egress: [] as string[], ingress: [] as string[] }

      // Only the half that said no, and only when it is a workload — a CIDR or
      // a domain has no policy of its own to report.
      if (verdict.egress.result === 'denied' && from.workload) {
        const d = await fetchWorkload(
          from.workload.namespace,
          from.workload.name,
          from.workload.kind,
        ).catch(() => null)
        next.egress = lines(d?.egress, 'to')
      }
      if (verdict.ingress.result === 'denied' && to.workload) {
        const d = await fetchWorkload(
          to.workload.namespace,
          to.workload.name,
          to.workload.kind,
        ).catch(() => null)
        next.ingress = lines(d?.ingress, 'from')
      }
      if (!cancelled) setAccepts(next)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [verdict, from.workload, to.workload])

  const egressCounterfactual = accepts.egress
  const ingressCounterfactual = accepts.ingress

  const portNum = Number(port)
  const portOk = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535
  const ready = Boolean(fromEP && toEP && portOk)

  const run = () => {
    if (!fromEP || !toEP || !portOk) return
    setRunning(true)
    setError(null)
    simulate({ from: fromEP.value, to: toEP.value, protocol, port: portNum })
      .then((v) => {
        setVerdict(v)
        setError(null)
      })
      .catch((e: Error) => {
        setVerdict(null)
        setError(e.message)
      })
      .finally(() => setRunning(false))
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          onEscapeKeyDown={(e) => {
            if (!Object.values(listsOpen.current).some(Boolean)) return
            e.preventDefault()
            setCloseLists((n) => n + 1)
          }}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex w-[min(42rem,94vw)] -translate-x-1/2 -translate-y-1/2',
            'max-h-[88vh] flex-col rounded-xl border border-line bg-elevated shadow-2xl outline-none',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          )}
        >
          <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3.5">
            <div>
              <Dialog.Title className="text-[14px] font-semibold tracking-tight">
                Would this connection be allowed?
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[11.5px] text-faint">
                Answered from declared policy. Marsad never sends a packet or reads one.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X />
              </Button>
            </Dialog.Close>
          </header>

          {/* Deliberately not scrollable: a suggestion list is positioned
              against these fields, and a scroll container would clip it. Only
              the verdict below scrolls. */}
          <form
            className="shrink-0 space-y-3.5 px-4 py-4"
            onSubmit={(e) => {
              e.preventDefault()
              run()
            }}
          >
            <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2.5">
              <EndpointField
                id="sim-from"
                label="From"
                value={from}
                onChange={setFrom}
                nodes={nodes}
                onListOpen={fromList}
                closeSignal={closeLists}
              />
              <ArrowRight className="mb-2.5 size-4 shrink-0 text-faint" />
              <EndpointField
                id="sim-to"
                label="To"
                value={to}
                onChange={setTo}
                nodes={nodes}
                onListOpen={toList}
                closeSignal={closeLists}
              />
            </div>

            <div className="flex flex-wrap items-end gap-2.5">
              <div>
                <span className="mb-1.5 block text-[11px] font-medium text-faint">Protocol</span>
                <ToggleGroup
                  type="single"
                  value={protocol}
                  onValueChange={(v) => v && setProtocol(v)}
                >
                  {['TCP', 'UDP', 'SCTP'].map((p) => (
                    <ToggleGroupItem key={p} value={p}>
                      {p}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>

              <div>
                <label
                  htmlFor="sim-port"
                  className="mb-1.5 block text-[11px] font-medium text-faint"
                >
                  Port
                </label>
                <input
                  id="sim-port"
                  value={port}
                  inputMode="numeric"
                  onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
                  className={cn(
                    'num h-9 w-24 rounded-lg border bg-bg px-3 text-[13px] text-fg outline-none',
                    portOk ? 'border-line focus:border-accent/60' : 'border-danger/60',
                  )}
                />
              </div>

              <Button
                type="submit"
                variant="default"
                size="md"
                disabled={!ready || running}
                className="ml-auto h-9"
              >
                {running && <Loader2 className="animate-spin" />}
                Check
              </Button>
            </div>
          </form>

          {(error || verdict) && (
            <div className="min-h-0 overflow-y-auto border-t border-line px-4 py-4">
              {error && (
                <p className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-[12.5px] text-danger">
                  {error}
                </p>
              )}

              {verdict && (
                <div className="space-y-2.5">
                  <Headline verdict={verdict} />
                  {/* Side by side, so "both must permit" is the shape of the
                      answer and not a sentence underneath it. Stacked, the
                      second half reads as a footnote to the first, which is
                      exactly the mistake the panel exists to prevent. */}
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    <Half
                      title="Egress · may the source leave"
                      decision={verdict.egress}
                      counterfactual={egressCounterfactual}
                    />
                    <Half
                      title="Ingress · will the destination accept"
                      decision={verdict.ingress}
                      counterfactual={ingressCounterfactual}
                    />
                  </div>
                  <p className="pt-0.5 text-[11px] leading-relaxed text-faint">
                    Both halves must permit a connection for it to work. Checking only one is the
                    usual way reading policy by hand goes wrong, so both are always shown —
                    including the one that is not in doubt.
                  </p>
                </div>
              )}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
