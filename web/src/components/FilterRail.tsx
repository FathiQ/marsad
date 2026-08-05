import { Boxes, Eye, Layers, RotateCcw, ShieldAlert, Waves } from 'lucide-react'
import { Virtuoso } from 'react-virtuoso'

import type { EdgeKind, Level, NamespaceSummary } from '../api'
import { hueFor, oklch, type NamespacePalette } from '../graph/style'
import { ALL_EDGE_KINDS, type Filters } from '../lib/filters'
import { cn } from '../lib/cn'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Separator } from './ui/separator'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { Tooltip } from './ui/tooltip'

interface Props {
  namespaces: NamespaceSummary[]
  selectedNamespaces: string[]
  onToggleNamespace: (name: string) => void
  onClearNamespaces: () => void
  level: Level
  onLevel: (level: Level) => void
  includeDefault: boolean
  onIncludeDefault: (value: boolean) => void
  animateFlow: boolean
  onAnimateFlow: (value: boolean) => void
  filters: Filters
  onFilters: (next: Filters) => void
  workloadKinds: string[]
  palette: NamespacePalette
  hidden: number
  onReset: () => void
}

function Section({
  icon: Icon,
  title,
  action,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2">
      <div className="flex h-5 items-center gap-1.5">
        <Icon className="size-3 text-faint" />
        <h2 className="text-[10.5px] font-semibold tracking-[0.07em] text-faint uppercase">
          {title}
        </h2>
        <div className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  )
}

function Row({
  checked,
  onChange,
  label,
  hint,
  swatch,
  trailing,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  hint?: string
  swatch?: string
  trailing?: React.ReactNode
}) {
  const row = (
    <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-elevated">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      {swatch && (
        <span className="size-2 shrink-0 rounded-[3px]" style={{ background: swatch }} />
      )}
      <span className="flex-1 truncate text-[12.5px] text-muted">{label}</span>
      {trailing}
    </label>
  )
  return hint ? <Tooltip content={hint} side="right">{row}</Tooltip> : row
}

const EDGE_KIND_LABEL: Record<EdgeKind, { label: string; hint: string; colour: string }> = {
  allowed: {
    label: 'Allowed by a rule',
    hint: 'A policy explicitly permits this traffic.',
    colour: 'var(--allowed)',
  },
  default: {
    label: 'Allowed by default',
    hint: 'Permitted only because no policy isolates the workload. The absence of a decision, not a decision.',
    colour: 'var(--neutral-edge)',
  },
  approximate: {
    label: 'Depends on DNS',
    hint: 'Whether these overlap cannot be decided from configuration — it depends on what a domain resolves to at runtime.',
    colour: 'var(--approx)',
  },
}

export function FilterRail({
  namespaces,
  selectedNamespaces,
  onToggleNamespace,
  onClearNamespaces,
  level,
  onLevel,
  includeDefault,
  onIncludeDefault,
  animateFlow,
  onAnimateFlow,
  filters,
  onFilters,
  workloadKinds,
  palette,
  hidden,
  onReset,
}: Props) {
  const setEdgeKind = (kind: EdgeKind, on: boolean) => {
    const next = new Set(filters.edgeKinds)
    if (on) next.add(kind)
    else next.delete(kind)
    onFilters({ ...filters, edgeKinds: next })
  }

  const setWorkloadKind = (kind: string, on: boolean) => {
    const next = new Set(filters.workloadKinds)
    if (on) next.add(kind)
    else next.delete(kind)
    onFilters({ ...filters, workloadKinds: next })
  }

  return (
    <aside className="flex w-[268px] shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex-1 space-y-5 overflow-y-auto p-3.5">
        <Section icon={Layers} title="Detail">
          <ToggleGroup
            type="single"
            value={level}
            onValueChange={(v) => v && onLevel(v as Level)}
            className="w-full"
          >
            <ToggleGroupItem value="namespace" className="flex-1">
              Namespace
            </ToggleGroupItem>
            <ToggleGroupItem value="workload" className="flex-1">
              Workload
            </ToggleGroupItem>
          </ToggleGroup>
        </Section>

        <Section icon={Waves} title="Connections">
          <div className="-mx-2">
            {ALL_EDGE_KINDS.map((kind) => {
              const meta = EDGE_KIND_LABEL[kind]
              return (
                <Row
                  key={kind}
                  // Allowed-by-default edges are omitted by the server rather
                  // than filtered locally, so that checkbox tracks the query.
                  checked={kind === 'default' ? includeDefault : filters.edgeKinds.has(kind)}
                  onChange={(v) => {
                    setEdgeKind(kind, v)
                    if (kind === 'default') onIncludeDefault(v)
                  }}
                  label={meta.label}
                  hint={meta.hint}
                  swatch={meta.colour}
                />
              )
            })}
            <Row
              checked={filters.hideDNS}
              onChange={(v) => onFilters({ ...filters, hideDNS: v })}
              label="Hide DNS edges"
              hint="Almost every egress-isolated workload needs port 53, so these edges are numerous and rarely what you are looking for."
            />
          </div>
        </Section>

        <Section icon={ShieldAlert} title="Posture">
          <div className="-mx-2">
            <Row
              checked={filters.onlyUnprotected}
              onChange={(v) => onFilters({ ...filters, onlyUnprotected: v })}
              label="Only unprotected"
              hint="Show only workloads that no policy selects at all."
            />
            <Row
              checked={filters.hideIsolatedNodes}
              onChange={(v) => onFilters({ ...filters, hideIsolatedNodes: v })}
              label="Hide unconnected nodes"
              hint="A node with no edges is often the finding rather than clutter, so this is off by default."
            />
          </div>
        </Section>

        {workloadKinds.length > 1 && (
          <Section icon={Boxes} title="Workload kind">
            <div className="-mx-2">
              {workloadKinds.map((kind) => (
                <Row
                  key={kind}
                  checked={filters.workloadKinds.size === 0 || filters.workloadKinds.has(kind)}
                  onChange={(v) => setWorkloadKind(kind, v)}
                  label={kind}
                />
              ))}
            </div>
          </Section>
        )}

        <Section icon={Eye} title="Motion">
          <div className="-mx-2">
            <Row
              checked={animateFlow}
              onChange={onAnimateFlow}
              label="Animate permitted paths"
              hint="Marsad reads declared policy, never observed traffic. The animation shows which paths a rule permits — not packets in flight."
            />
          </div>
        </Section>

        <Separator />

        <Section
          icon={Layers}
          title="Namespaces"
          action={
            selectedNamespaces.length > 0 ? (
              <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[11px] text-accent" onClick={onClearNamespaces}>
                clear {selectedNamespaces.length}
              </Button>
            ) : undefined
          }
        >
          <div className="overflow-hidden rounded-lg border border-line bg-bg">
            {namespaces.length === 0 ? (
              <p className="px-2.5 py-3 text-[12px] text-faint">No namespaces yet.</p>
            ) : (
              <Virtuoso
                style={{ height: Math.min(namespaces.length * 30, 300) }}
                data={namespaces}
                itemContent={(_, ns) => {
                  const on = selectedNamespaces.includes(ns.name)
                  return (
                    <button
                      onClick={() => onToggleNamespace(ns.name)}
                      className={cn(
                        'flex w-full items-center gap-2.5 border-b border-line px-2.5 py-1.5 text-left transition-colors last:border-b-0',
                        on ? 'bg-accent/12 shadow-[inset_2px_0_0_var(--accent)]' : 'hover:bg-elevated',
                      )}
                    >
                      <span
                        className="size-2 shrink-0 rounded-[3px]"
                        style={{ background: oklch(0.7, 0.15, hueFor(palette, ns.name)) }}
                      />
                      <span className="flex-1 truncate text-[12.5px] text-muted">{ns.name}</span>
                      <span
                        className={cn(
                          'num text-[11px]',
                          ns.unprotected > 0 ? 'font-semibold text-danger' : 'text-faint',
                        )}
                      >
                        {ns.unprotected > 0 ? `${ns.unprotected}/${ns.workloads}` : ns.workloads}
                      </span>
                    </button>
                  )
                }}
              />
            )}
          </div>
        </Section>
      </div>

      {hidden > 0 && (
        <div className="flex items-center gap-2 border-t border-line px-3.5 py-2.5">
          <Badge tone="warn">{hidden} hidden</Badge>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={onReset} className="gap-1.5">
            <RotateCcw className="size-3" />
            reset
          </Button>
        </div>
      )}
    </aside>
  )
}
