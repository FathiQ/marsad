import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  NotReadyError,
  fetchGraph,
  fetchMeta,
  fetchNamespaces,
  openStream,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type Level,
  type Meta,
  type NamespaceSummary,
} from './api'
import { GraphView } from './graph/GraphView'
import { DetailDrawer } from './panels/DetailDrawer'
import { Legend } from './panels/Legend'
import { Sidebar } from './panels/Sidebar'

/** Observatory dome. Kept to a single small mark — the graph is the thing worth
 * looking at, not the branding. */
function Mark() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 20h18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M5 20a7 7 0 0 1 14 0"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path d="M12 13V4" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="3.2" r="1.6" fill="var(--accent)" />
    </svg>
  )
}

type Theme = 'dark' | 'light'

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [namespaces, setNamespaces] = useState<NamespaceSummary[]>([])
  const [graph, setGraph] = useState<Graph | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(true)
  const [connected, setConnected] = useState(false)

  const [level, setLevel] = useState<Level>('namespace')
  const [selectedNs, setSelectedNs] = useState<string[]>([])
  const [includeDefault, setIncludeDefault] = useState(true)

  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('marsad.theme') as Theme | null) ?? 'dark',
  )
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('marsad.theme', theme)
  }, [theme])

  const query = useMemo(
    () => ({ level, namespaces: selectedNs, includeDefault }),
    [level, selectedNs, includeDefault],
  )

  // Metadata and the namespace list, refreshed when the stream reports a new
  // revision rather than on a timer.
  const loadSummaries = useCallback(async () => {
    try {
      const [m, ns] = await Promise.all([fetchMeta(), fetchNamespaces()])
      setMeta(m)
      setNamespaces(ns)
      setSyncing(false)
      setError(null)
    } catch (e) {
      if (e instanceof NotReadyError) {
        setSyncing(true)
        return
      }
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void loadSummaries()
    // While the informers are still syncing there is nothing to show, so poll
    // until there is. This only runs during the first seconds after startup.
    const t = window.setInterval(() => {
      if (syncing) void loadSummaries()
    }, 2000)
    return () => window.clearInterval(t)
  }, [loadSummaries, syncing])

  // Initial graph over HTTP, then live updates over the socket. Fetching once
  // means the first paint does not wait on a websocket handshake.
  useEffect(() => {
    let cancelled = false
    fetchGraph(query)
      .then((r) => !cancelled && setGraph(r.graph))
      .catch((e: Error) => {
        if (cancelled || e instanceof NotReadyError) return
        setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [query])

  useEffect(() => {
    const close = openStream(
      query,
      (msg) => {
        if (msg.graph) {
          setGraph(msg.graph)
          setSyncing(false)
        }
        void loadSummaries()
      },
      setConnected,
    )
    return close
  }, [query, loadSummaries])

  // Keyboard: / focuses search, Escape closes the drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLElement &&
        ['INPUT', 'TEXTAREA'].includes(e.target.tagName)
      if (e.key === '/' && !typing) {
        e.preventDefault()
        searchRef.current?.focus()
      }
      if (e.key === 'Escape' && !typing) {
        setSelectedNode(null)
        setSelectedEdge(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const nodesById = useMemo(
    () => new Map((graph?.nodes ?? []).map((n) => [n.id, n])),
    [graph],
  )

  const toggleNamespace = useCallback((name: string) => {
    setSelectedNs((cur) =>
      cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name],
    )
  }, [])

  const focusNode = useCallback((node: GraphNode) => {
    setFocusId(node.id)
    setSelectedNode(node)
    setSelectedEdge(null)
  }, [])

  const unavailable = meta?.capabilities.policies.filter((p) => !p.available) ?? []
  const totalUnprotected = namespaces.reduce((sum, ns) => sum + ns.unprotected, 0)

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <Mark />
          Marsad
          <span className="tag">the observatory for your Kubernetes network policies</span>
        </div>

        <div className="spacer" />

        {meta && (
          <>
            <span className="stat">
              <b>{meta.counts.namespaces}</b> namespaces
            </span>
            <span className="stat">
              <b>{meta.counts.workloads}</b> workloads
            </span>
            <span className="stat">
              <b>{meta.counts.policies}</b> policies
            </span>
            {totalUnprotected > 0 && (
              <span className="stat alert" title="Workloads no policy selects at all">
                <b>{totalUnprotected}</b> unprotected
              </span>
            )}
          </>
        )}

        {unavailable.map((c) => (
          <span className="pill off" key={c.provider} title={c.reason}>
            <span className="dot" />
            {c.provider === 'aws-anp' ? 'domain policies unavailable' : `${c.provider} unavailable`}
          </span>
        ))}

        <span className={`pill ${connected ? '' : 'off'}`} title={connected ? 'Live' : 'Reconnecting…'}>
          <span className="dot" />
          {connected ? 'live' : 'offline'}
        </span>

        <button
          className="icon-btn"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? '☾' : '☀'}
        </button>
      </header>

      <div className="body">
        <Sidebar
          namespaces={namespaces}
          selected={selectedNs}
          onToggle={toggleNamespace}
          onClear={() => setSelectedNs([])}
          level={level}
          onLevel={setLevel}
          includeDefault={includeDefault}
          onIncludeDefault={setIncludeDefault}
          nodes={graph?.nodes ?? []}
          onFocusNode={focusNode}
          searchRef={searchRef}
        />

        <div className="canvas-wrap">
          {graph && (
            <GraphView
              data={graph}
              theme={theme}
              selectedId={selectedEdge?.id ?? selectedNode?.id ?? null}
              focusId={focusId}
              onSelectNode={(n) => {
                setSelectedNode(n)
                setSelectedEdge(null)
              }}
              onSelectEdge={(e) => {
                setSelectedEdge(e)
                setSelectedNode(null)
              }}
              onClearSelection={() => {
                setSelectedNode(null)
                setSelectedEdge(null)
              }}
            />
          )}

          {graph && graph.nodes.length > 0 && <Legend level={level} />}
          {graph && graph.nodes.length > 0 && (
            <div className="hint">
              <kbd>/</kbd> search · <kbd>esc</kbd> close · click an edge for the rule behind it
            </div>
          )}

          {graph?.truncated && (
            <div className="banner">
              Some peers matched more workloads than can be drawn individually and were collapsed to
              their namespace.
            </div>
          )}

          {syncing && !graph && (
            <div className="overlay">
              <div className="inner">
                <div className="spinner" />
                <h2>Syncing cluster state</h2>
                <p>Reading namespaces, workloads and policies. This takes a moment on first start.</p>
              </div>
            </div>
          )}

          {error && (
            <div className="overlay">
              <div className="inner">
                <h2>Could not reach the API</h2>
                <p>{error}</p>
                <p style={{ color: 'var(--text-faint)', fontSize: 13, marginTop: 10 }}>
                  Marsad is read-only, so this is safe to retry.
                </p>
              </div>
            </div>
          )}

          {!syncing && !error && graph && graph.nodes.length === 0 && (
            <div className="overlay">
              <div className="inner">
                <h2>Nothing to draw</h2>
                <p>
                  {selectedNs.length > 0
                    ? 'No workloads in the selected namespaces.'
                    : 'This cluster has no workloads Marsad can see.'}
                </p>
              </div>
            </div>
          )}

          <DetailDrawer
            node={selectedNode}
            edge={selectedEdge}
            nodesById={nodesById}
            onClose={() => {
              setSelectedNode(null)
              setSelectedEdge(null)
            }}
          />
        </div>
      </div>
    </div>
  )
}
