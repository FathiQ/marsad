import { Copy, ExternalLink, TriangleAlert, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { fetchRules, type GraphEdge, type GraphNode, type RuleDetail } from '../api'
import { cn } from '../lib/cn'
import { Badge } from './ui/badge'
import { Button } from './ui/button'

interface Props {
  edge: GraphEdge
  at: { x: number; y: number }
  source?: GraphNode
  target?: GraphNode
  onClose: () => void
  onOpenNode: (node: GraphNode) => void
}

const KIND: Record<GraphEdge['kind'], { tone: 'ok' | 'neutral' | 'warn'; label: string }> = {
  allowed: { tone: 'ok', label: 'allowed by a rule' },
  default: { tone: 'neutral', label: 'allowed by default' },
  approximate: { tone: 'warn', label: 'depends on DNS' },
}

const WIDTH = 380

/**
 * The rule behind an edge, where the edge is.
 *
 * The app has promised "click an edge for the rule behind it" along the bottom
 * of the canvas since the beginning, and clicking one opened the same side
 * panel that workloads use — which meant the answer appeared several hundred
 * pixels from the question, after the graph had shifted to make room for it.
 * An anchored popover keeps the edge, the click and the explanation in one
 * place, and the excerpt is the matching rule rather than the whole document
 * it happens to live in.
 */
export function EdgePopover({ edge, at, source, target, onClose, onOpenNode }: Props) {
  const [rules, setRules] = useState<RuleDetail[] | null>(null)
  const [copied, setCopied] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setRules(null)
    fetchRules(edge.via ?? [])
      .then((r) => !cancelled && setRules(r))
      .catch(() => !cancelled && setRules([]))
    return () => {
      cancelled = true
    }
  }, [edge])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    // Deferred by a tick: the click that opened this would otherwise close it.
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    const timer = window.setTimeout(() => window.addEventListener('mousedown', onDown), 0)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
      window.clearTimeout(timer)
    }
  }, [onClose])

  const yaml = rules?.map((r) => r.yaml).filter(Boolean).join('\n---\n') ?? ''
  const cautions = rules?.flatMap((r) => r.cautions ?? []) ?? []

  const copy = () => {
    void navigator.clipboard?.writeText(yaml).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }

  const kind = KIND[edge.kind]
  const [placement, setPlacement] = useState({ left: at.x + 16, top: Math.max(8, at.y - 12) })

  /*
   * Placed after measuring, not before.
   *
   * The first attempt positioned itself from a ref that is null on the first
   * render, so the fallback width won every time and the panel was always
   * pushed to the *left* of the click — over the card it was describing, which
   * is the one thing an anchored popover must not do. Measuring the stage in a
   * layout effect means the flip to the other side happens because there is
   * genuinely no room, and it happens before paint.
   */
  useLayoutEffect(() => {
    const stage = box.current?.offsetParent as HTMLElement | null
    const height = box.current?.offsetHeight ?? 0
    const stageW = stage?.clientWidth ?? window.innerWidth
    const stageH = stage?.clientHeight ?? window.innerHeight

    const right = at.x + 16
    const left = right + WIDTH + 8 > stageW ? at.x - WIDTH - 16 : right

    setPlacement({
      left: Math.max(8, Math.min(left, stageW - WIDTH - 8)),
      top: Math.max(8, Math.min(at.y - 12, stageH - height - 8)),
    })
  }, [at, rules])

  return (
    <>
      {/* Where the click landed, so the popover is visibly *about* that point
          rather than floating near it. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute z-30 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-canvas"
        style={{ left: at.x, top: at.y }}
      />

      <div
        ref={box}
        role="dialog"
        aria-label="Connection"
        style={{ left: placement.left, top: placement.top, width: WIDTH }}
        className="absolute z-30 overflow-hidden rounded-xl border border-line bg-overlay shadow-2xl"
      >
        <header className="flex items-center gap-2 border-b border-line px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-body">
            <span className="font-medium text-fg">{source?.label ?? edge.source}</span>
            <span className="px-1.5 text-text-dim">→</span>
            <span className="font-medium text-fg">{target?.label ?? edge.target}</span>
          </span>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <X />
          </Button>
        </header>

        <div className="space-y-2.5 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={kind.tone}>{kind.label}</Badge>
            <span className="font-mono text-[11.5px] text-text-body">
              {edge.ports?.length ? edge.ports.join(', ') : 'all ports'}
            </span>
          </div>

          {edge.note && (
            <p className="border-l-2 border-approx/50 pl-2.5 text-[11.5px] leading-relaxed text-approx-text">
              {edge.note}
            </p>
          )}

          {/* Derived from the rule, not matched against a list of strings. */}
          {cautions.map((line) => (
            <p
              key={line}
              className="flex gap-2 rounded-lg border border-danger/40 bg-danger/10 p-2.5 text-[11.5px] leading-relaxed text-danger"
            >
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
              {line}
            </p>
          ))}

          {rules === null ? (
            <div className="h-16 animate-pulse rounded-lg bg-elevated" aria-busy="true" />
          ) : rules.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line px-3 py-3 text-center text-[11.5px] text-muted">
              Nothing declares this. It exists because no policy isolates the workload.
            </p>
          ) : (
            <div className="space-y-2">
              {rules.map((rule) => (
                <div key={rule.id} className="overflow-hidden rounded-lg border border-line bg-bg">
                  <div className="flex items-center gap-1.5 border-b border-line px-2.5 py-1.5">
                    <Badge tone="neutral" className="font-mono">
                      {rule.provider === 'aws-anp' ? 'anp' : 'netpol'}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg">
                      {rule.policy.name}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-text-dim">
                      {rule.path}
                    </span>
                  </div>
                  <pre className="max-h-48 overflow-auto p-2.5 font-mono text-[10.5px] leading-relaxed text-text-body">
                    {rule.yaml ?? '# the rule could not be rendered'}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>

        <footer className="flex items-center gap-1.5 border-t border-line bg-panel px-3 py-2">
          {target && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => onOpenNode(target)}
            >
              <ExternalLink className="size-3" />
              Open {target.label}
            </Button>
          )}
          <div className="flex-1" />
          {yaml && (
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={copy}>
              <Copy className={cn('size-3', copied && 'text-allowed-text')} />
              {copied ? 'copied' : 'Copy YAML'}
            </Button>
          )}
        </footer>
      </div>
    </>
  )
}
