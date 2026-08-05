import { useMemo, useRef, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'

import type { GraphNode, Level, NamespaceSummary } from '../api'

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
      <div>
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
          <div className="ns-list">
            {matches.slice(0, 8).map((n) => (
              <button key={n.id} className="ns-row" onClick={() => onFocusNode(n)}>
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

      <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column', flex: 1 }}>
        <h3 className="panel-title">
          Namespaces
          {selected.length > 0 && (
            <button
              onClick={onClear}
              style={{ float: 'right', fontSize: 11, color: 'var(--accent)', padding: 0 }}
            >
              clear ({selected.length})
            </button>
          )}
        </h3>
        <div className="ns-list" ref={listRef} style={{ flex: 1, minHeight: 120 }}>
          {shown.length === 0 ? (
            <div style={{ padding: 10, color: 'var(--text-faint)', fontSize: 12 }}>
              No namespace matches.
            </div>
          ) : (
            <Virtuoso
              style={{ height: Math.min(shown.length * 31, 340) }}
              data={shown}
              itemContent={(_, ns) => (
                <button
                  className={`ns-row ${selected.includes(ns.name) ? 'on' : ''}`}
                  onClick={() => onToggle(ns.name)}
                  title={`${ns.workloads} workloads, ${ns.policies} policies, ${ns.unprotected} unprotected`}
                >
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
