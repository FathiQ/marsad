import { useMemo, useRef, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'

import type { GraphNode, Level, NamespaceSummary } from '../api'
import { namespaceSwatch, type NamespacePalette } from '../graph/style'

interface Props {
  namespaces: NamespaceSummary[]
  selected: string[]
  onToggle: (name: string) => void
  onClear: () => void
  level: Level
  onLevel: (level: Level) => void
  includeDefault: boolean
  onIncludeDefault: (value: boolean) => void
  nodes: GraphNode[]
  onFocusNode: (node: GraphNode) => void
  searchRef: React.RefObject<HTMLInputElement>
  palette: NamespacePalette
}

/** Subsequence match, so "kbsys" finds "kube-system" the way a fuzzy finder
 * would. Cheap enough to run over every node on each keystroke. */
function fuzzy(haystack: string, needle: string): boolean {
  if (!needle) return true
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()
  let i = 0
  for (const ch of h) {
    if (ch === n[i]) i++
    if (i === n.length) return true
  }
  return false
}

export function Sidebar({
  namespaces,
  selected,
  onToggle,
  onClear,
  level,
  onLevel,
  includeDefault,
  onIncludeDefault,
  nodes,
  onFocusNode,
  searchRef,
  palette,
}: Props) {
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  const matches = useMemo(() => {
    if (!query.trim()) return []
    return nodes.filter((n) => fuzzy(`${n.namespace ?? ''} ${n.label}`, query.trim())).slice(0, 40)
  }, [nodes, query])

  const shown = useMemo(
    () => namespaces.filter((ns) => fuzzy(ns.name, query.trim())),
    [namespaces, query],
  )

  return (
    <aside className="sidebar">
      <div className="search-wrap">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" strokeLinecap="round" />
        </svg>
        <input
          ref={searchRef}
          className="search"
          placeholder="Search  ( / )"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setQuery('')
              e.currentTarget.blur()
            }
            if (e.key === 'Enter' && matches[0]) onFocusNode(matches[0])
          }}
          aria-label="Search namespaces and workloads"
        />
      </div>

      {matches.length > 0 && (
        <div>
          <h3 className="panel-title">Jump to</h3>
          <div className="card">
            {matches.slice(0, 8).map((n) => (
              <button key={n.id} className="ns-row" onClick={() => onFocusNode(n)}>
                <span
                  className="swatch"
                  style={{ background: namespaceSwatch(palette, n.namespace ?? n.label) }}
                />
                <span className="name">{n.label}</span>
                <span className="count">{n.namespace ?? n.kind}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="panel-title">Detail</h3>
        <div className="seg" role="group" aria-label="Aggregation level">
          <button className={level === 'namespace' ? 'on' : ''} onClick={() => onLevel('namespace')}>
            Namespace
          </button>
          <button className={level === 'workload' ? 'on' : ''} onClick={() => onLevel('workload')}>
            Workload
          </button>
        </div>
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={includeDefault}
          onChange={(e) => onIncludeDefault(e.target.checked)}
        />
        {/* On a cluster with no policies this is every workload, which is both
            the honest picture and a lot of edges. Hence the switch. */}
        Show allowed-by-default
      </label>

      <div>
        <h3 className="panel-title">
          <span>Namespaces</span>
          {selected.length > 0 && <button onClick={onClear}>clear ({selected.length})</button>}
        </h3>
        {/* Sized to its contents rather than stretched: a flexed card clipped
            the last namespace against the sidebar's own scroll. */}
        <div className="card" ref={listRef}>
          {shown.length === 0 ? (
            <div style={{ padding: 10, color: 'var(--text-faint)', fontSize: 12 }}>
              No namespace matches.
            </div>
          ) : (
            <Virtuoso
              style={{ height: Math.min(shown.length * 32, 420) }}
              data={shown}
              itemContent={(_, ns) => (
                <button
                  className={`ns-row ${selected.includes(ns.name) ? 'on' : ''}`}
                  onClick={() => onToggle(ns.name)}
                  title={`${ns.workloads} workloads, ${ns.policies} policies, ${ns.unprotected} unprotected`}
                >
                  {/* The same hue the graph gives this namespace, so the filter
                      and the canvas agree at a glance. */}
                  <span
                    className="swatch"
                    style={{ background: namespaceSwatch(palette, ns.name) }}
                  />
                  <span className="name">{ns.name}</span>
                  <span className={`count ${ns.unprotected > 0 ? 'bad' : ''}`}>
                    {ns.unprotected > 0 ? `${ns.unprotected}/${ns.workloads}` : ns.workloads}
                  </span>
                </button>
              )}
            />
          )}
        </div>
      </div>
    </aside>
  )
}
