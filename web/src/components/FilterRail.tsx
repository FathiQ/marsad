import { ChevronRight, Layers, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'

import type { EdgeKind, Level, NamespaceSummary } from '../api'
import { hueFor, oklch, type NamespacePalette } from '../graph/style'
import { ALL_EDGE_KINDS, type Filters } from '../lib/filters'
import { cn } from '../lib/cn'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
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
  showGroups: boolean
  onShowGroups: (value: boolean) => void
  filters: Filters
  onFilters: (next: Filters) => void
  workloadKinds: string[]
  palette: NamespacePalette
  /** Edge totals per kind, so a toggle can say what turning it off costs. */
  edgeCounts: Partial<Record<EdgeKind, number>>
  /** Workloads drawn versus workloads the graph holds. */
  shown: number
  total: number
  /** Whether anything is actually being hidden right now. */
  hiding: boolean
  onReset: () => void
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="px-2 text-[10px] font-semibold tracking-[0.08em] text-text-dim uppercase">
        {title}
      </h3>
      <div className="-mx-0.5">{children}</div>
    </section>
  )
}

function Row({
  checked,
  onChange,
  label,
  hint,
  swatch,
  count,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  hint?: string
  swatch?: string
  count?: number
}) {
  const row = (
    <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-elevated">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      {swatch && <span className="size-2 shrink-0 rounded-[3px]" style={{ background: swatch }} />}
      <span className="flex-1 truncate text-[12.5px] text-text-body">{label}</span>
      {/* The cost of turning this off, before it is paid. */}
      {count !== undefined && <span className="num text-[11px] text-text-dim">{count}</span>}
    </label>
  )
  return hint ? (
    <Tooltip content={hint} side="right">
      {row}
    </Tooltip>
  ) : (
    row
  )
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

/**
 * Namespaces, worst first.
 *
 * Alphabetical order is the one ordering that guarantees the thing you are
 * looking for is wherever the alphabet happens to put it. Sorting by unprotected
 * count puts the namespaces with a finding at the top, where a rail is actually
 * read, and leaves the rest in a stable alphabetical tail.
 *
 * Empty namespaces are separated out rather than sorted to the bottom. A
 * namespace with no workloads cannot have a posture at all, so ranking it
 * against ones that can is a category error — and it is also, usually, not what
 * anyone is looking for.
 */
function partition(namespaces: NamespaceSummary[]) {
  const populated = namespaces.filter((ns) => ns.workloads > 0)
  const empty = namespaces.filter((ns) => ns.workloads === 0)
  populated.sort(
    (a, b) => b.unprotected - a.unprotected || a.name.localeCompare(b.name),
  )
  empty.sort((a, b) => a.name.localeCompare(b.name))
  return { populated, empty }
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
  showGroups,
  onShowGroups,
  filters,
  onFilters,
  workloadKinds,
  palette,
  edgeCounts,
  shown,
  total,
  hiding,
  onReset,
}: Props) {
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [query, setQuery] = useState('')

  // Typing beats scrolling past forty entries, and the list is the primary
  // navigation on a large cluster.
  const matching = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? namespaces.filter((ns) => ns.name.toLowerCase().includes(q)) : namespaces
  }, [namespaces, query])
  const { populated, empty } = useMemo(() => partition(matching), [matching])

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

  const namespaceRow = (ns: NamespaceSummary, dimmed = false) => {
    const on = selectedNamespaces.includes(ns.name)
    return (
      <button
        onClick={() => onToggleNamespace(ns.name)}
        aria-pressed={on}
        className={cn(
          'flex w-full items-center gap-2.5 border-b border-line px-2.5 py-1.5 text-left transition-colors last:border-b-0',
          'outline-none focus-visible:ring-2 focus-visible:ring-accent/70 -outline-offset-2',
          on ? 'bg-accent/12 shadow-[inset_2px_0_0_var(--accent)]' : 'hover:bg-elevated',
        )}
      >
        <span
          className="size-2 shrink-0 rounded-[3px]"
          style={{
            background: oklch(0.7, dimmed ? 0.02 : 0.15, hueFor(palette, ns.name)),
          }}
        />
        <span
          className={cn(
            'flex-1 truncate text-[12.5px]',
            dimmed ? 'text-text-dim' : 'text-text-body',
          )}
        >
          {ns.name}
        </span>
        {ns.workloads > 0 && (
          <span
            className={cn(
              'num text-[11px]',
              ns.unprotected > 0 ? 'font-semibold text-danger' : 'text-text-dim',
            )}
          >
            {ns.unprotected > 0 ? `${ns.unprotected}/${ns.workloads}` : ns.workloads}
          </span>
        )}
      </button>
    )
  }

  return (
    <aside className="flex w-[268px] shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3.5">
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

        {/* Primary navigation, not a filter. On a cluster with forty namespaces
            this list is how anyone gets anywhere, and it used to sit below four
            sections of checkboxes. */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-5 items-center gap-1.5 px-0.5">
            <Layers className="size-3 text-text-dim" />
            <h2 className="text-[10px] font-semibold tracking-[0.08em] text-text-dim uppercase">
              Namespaces
            </h2>
            <div className="flex-1" />
            {selectedNamespaces.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-1.5 text-[11px] text-accent"
                onClick={onClearNamespaces}
              >
                clear {selectedNamespaces.length}
              </Button>
            )}
          </div>

          {namespaces.length > 5 && (
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter namespaces"
              aria-label="Filter namespaces"
              className="mt-2 h-7 w-full rounded-md border border-line bg-bg px-2 text-[12px] text-fg outline-none placeholder:text-text-dim focus-visible:border-accent/60"
            />
          )}

          <div className="mt-2 min-h-0 flex-1 overflow-hidden rounded-lg border border-line bg-bg">
            {matching.length === 0 ? (
              <p className="px-2.5 py-3 text-[12px] text-text-dim">
                {namespaces.length === 0 ? 'No namespaces yet.' : 'No namespace matches.'}
              </p>
            ) : (
              <div className="flex h-full flex-col">
                <div className="min-h-0 flex-1">
                  <Virtuoso
                    style={{ height: '100%' }}
                    data={populated}
                    itemContent={(_, ns) => namespaceRow(ns)}
                  />
                </div>

                {/* Kept out of the ranking rather than sorted to the end: a
                    namespace with no workloads has no posture to compare. */}
                {empty.length > 0 && (
                  <details className="group shrink-0 border-t border-line">
                    <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-text-dim hover:bg-elevated">
                      <ChevronRight className="size-3 text-line-faint transition-transform group-open:rotate-90" />
                      <span className="num">{empty.length}</span>
                      <span>with no workloads</span>
                    </summary>
                    <div className="max-h-40 overflow-y-auto border-t border-line">
                      {empty.map((ns) => (
                        <div key={ns.name}>{namespaceRow(ns, true)}</div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}
          </div>
        </div>

        {/* One row instead of four sections. The filters are worth having and
            are not worth a third of the rail when nobody has asked for them. */}
        <div className="shrink-0 overflow-hidden rounded-lg border border-line bg-bg">
          <button
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
            className={cn(
              'flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-elevated',
              'outline-none focus-visible:ring-2 focus-visible:ring-accent/70 -outline-offset-2',
            )}
          >
            <SlidersHorizontal className="size-3.5 text-text-dim" />
            <span className="flex-1 text-[12.5px] text-text-body">Filters</span>
            {/* Only when something is genuinely hidden. A badge that is always
                lit cannot say the one thing it exists to say. */}
            {hiding && <Badge tone="warn">hiding</Badge>}
            <ChevronRight
              className={cn(
                'size-3.5 text-line-faint transition-transform',
                filtersOpen && 'rotate-90',
              )}
            />
          </button>

          {filtersOpen && (
            <div className="space-y-3 border-t border-line p-2">
              <Group title="Connections">
                {ALL_EDGE_KINDS.map((kind) => {
                  const meta = EDGE_KIND_LABEL[kind]
                  return (
                    <Row
                      key={kind}
                      // Allowed-by-default edges are omitted by the server
                      // rather than filtered locally, so that box tracks the
                      // query — and its count is unknown while it is off.
                      checked={kind === 'default' ? includeDefault : filters.edgeKinds.has(kind)}
                      onChange={(v) => {
                        setEdgeKind(kind, v)
                        if (kind === 'default') onIncludeDefault(v)
                      }}
                      label={meta.label}
                      hint={meta.hint}
                      swatch={meta.colour}
                      count={edgeCounts[kind]}
                    />
                  )
                })}
                <Row
                  checked={filters.hideDNS}
                  onChange={(v) => onFilters({ ...filters, hideDNS: v })}
                  label="Hide DNS edges"
                  hint="Almost every egress-isolated workload needs port 53, so these edges are numerous and rarely what you are looking for."
                />
              </Group>

              <Group title="Posture">
                <Row
                  checked={filters.onlyUnprotected}
                  onChange={(v) => onFilters({ ...filters, onlyUnprotected: v })}
                  label="Only unprotected"
                  hint="Show only workloads that no policy selects at all."
                />
                <Row
                  checked={filters.onlyExposed}
                  onChange={(v) => onFilters({ ...filters, onlyExposed: v })}
                  label="Only reachable from outside"
                  hint="Workloads something outside the cluster can reach, following the direction traffic flows. Being able to call the internet is not the same thing — that would be every workload with egress."
                />
                <Row
                  checked={filters.hideIsolatedNodes}
                  onChange={(v) => onFilters({ ...filters, hideIsolatedNodes: v })}
                  label="Hide unconnected nodes"
                  hint="A node with no edges is often the finding rather than clutter, so this is off by default."
                />
              </Group>

              {/* Only when there is more than one kind to choose between, so the
                  panel does not carry a heading that filters nothing. */}
              {workloadKinds.length > 1 && (
                <Group title="Workload kind">
                  {workloadKinds.map((kind) => (
                    <Row
                      key={kind}
                      checked={filters.workloadKinds.size === 0 || filters.workloadKinds.has(kind)}
                      onChange={(v) => setWorkloadKind(kind, v)}
                      label={kind}
                    />
                  ))}
                </Group>
              )}

              <Group title="Layout">
                <Row
                  checked={animateFlow}
                  onChange={onAnimateFlow}
                  label="Animate permitted paths"
                  hint="Marsad reads declared policy, never observed traffic. The animation shows which paths a rule permits — not packets in flight."
                />
                <Row
                  checked={showGroups}
                  onChange={onShowGroups}
                  label="Group by namespace"
                  hint="Draws a container around the workloads of each namespace, so what belongs together is visible rather than inferred from colour."
                />
              </Group>
            </div>
          )}
        </div>
      </div>

      {/* Always present, so "nothing is hidden" is stated rather than inferred
          from the absence of a warning. */}
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3.5 py-2.5">
        <p className="flex-1 truncate text-[11px] text-text-dim">
          {hiding ? 'Filters are hiding part of this' : 'Nothing hidden'}
          <span className="px-1 opacity-50">·</span>
          <span className="num">{shown}</span> of <span className="num">{total}</span> workloads
        </p>
        {hiding && (
          <Button size="sm" variant="ghost" onClick={onReset} className="gap-1.5">
            <RotateCcw className="size-3" />
            reset
          </Button>
        )}
      </div>
    </aside>
  )
}
