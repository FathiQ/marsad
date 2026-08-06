import { useCallback, useEffect, useMemo, useState } from 'react'
import { ShieldOff, Telescope, TriangleAlert } from 'lucide-react'

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
import { AppHeader } from './components/AppHeader'
import { CommandPalette } from './components/CommandPalette'
import { FilterRail } from './components/FilterRail'
import { GraphCanvas } from './components/GraphCanvas'
import { Inspector } from './components/Inspector'
import { Legend } from './components/Legend'
import { Splash } from './components/Splash'
import { SimulatePanel, type Prefill } from './components/SimulatePanel'
import { Kbd } from './components/ui/kbd'
import { TooltipProvider } from './components/ui/tooltip'
import { buildNamespacePalette } from './graph/style'
import {
  applyFilters,
  defaultFilters,
  hiddenCount,
  presentWorkloadKinds,
  type Filters,
} from './lib/filters'

type Theme = 'dark' | 'light'

/**
 * Applied synchronously rather than from an effect.
 *
 * React runs child effects before parent ones, so the canvas would read the CSS
 * variables for the *previous* theme and paint its labels in it — invisible text
 * on a matching background. Setting the attribute outside the effect ordering
 * removes the race rather than working around it.
 */
function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
  localStorage.setItem('marsad.theme', theme)
}

const initialTheme: Theme = (localStorage.getItem('marsad.theme') as Theme | null) ?? 'dark'
applyTheme(initialTheme)

function Overlay({
  icon: Icon,
  title,
  children,
  spin,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  children?: React.ReactNode
  spin?: boolean
}) {
  return (
    <div className="absolute inset-0 z-10 grid place-items-center bg-canvas px-6 text-center">
      <div className="max-w-md space-y-2">
        <Icon className={`mx-auto size-7 text-faint ${spin ? 'animate-spin' : ''}`} />
        <h2 className="text-[16px] font-semibold tracking-tight">{title}</h2>
        <div className="text-[13px] leading-relaxed text-muted">{children}</div>
      </div>
    </div>
  )
}

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
  const [filters, setFilters] = useState<Filters>(defaultFilters)
  const [animateFlow, setAnimateFlow] = useState(true)
  const [showGroups, setShowGroups] = useState(true)

  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [simulateOpen, setSimulateOpen] = useState(false)

  const query = useMemo(
    () => ({ level, namespaces: selectedNs, includeDefault }),
    [level, selectedNs, includeDefault],
  )

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
    // until there is. This runs only during the first seconds after startup.
    const t = window.setInterval(() => {
      if (syncing) void loadSummaries()
    }, 2000)
    return () => window.clearInterval(t)
  }, [loadSummaries, syncing])

  // Initial graph over HTTP so the first paint does not wait on a websocket
  // handshake; live updates arrive on the socket afterwards.
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
    return openStream(
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
  }, [query, loadSummaries])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)

      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault()
        setPaletteOpen(true)
      }
      if (e.key === 's' && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        setSimulateOpen(true)
      }
      if (e.key === 'Escape' && !typing) {
        setSelectedNode(null)
        setSelectedEdge(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const palette = useMemo(
    () => buildNamespacePalette(namespaces.map((ns) => ns.name)),
    [namespaces],
  )

  const filtered = useMemo(() => (graph ? applyFilters(graph, filters) : null), [graph, filters])

  /**
   * Everything that means "show me something else", and nothing that means "the
   * cluster changed".
   *
   * The canvas cannot tell those apart — both arrive as a new graph — and the
   * difference decides whether reframing is helpful or is the camera wandering
   * off on its own. Only this component knows which of the two happened.
   */
  const viewToken = useMemo(
    () =>
      [
        level,
        includeDefault,
        selectedNs.join(','),
        filters.onlyUnprotected,
        filters.hideIsolatedNodes,
        filters.hideDNS,
        [...filters.workloadKinds].sort().join(','),
        [...filters.edgeKinds].sort().join(','),
      ].join('|'),
    [level, includeDefault, selectedNs, filters],
  )
  const hidden = graph && filtered ? hiddenCount(graph, filtered) : 0
  const workloadKinds = useMemo(() => presentWorkloadKinds(graph), [graph])

  const nodesById = useMemo(
    () => new Map((filtered?.nodes ?? []).map((n) => [n.id, n])),
    [filtered],
  )

  const toggleNamespace = useCallback((name: string) => {
    setSelectedNs((cur) => (cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]))
  }, [])

  const focusNode = useCallback((node: GraphNode) => {
    setFocusId(node.id)
    setSelectedNode(node)
    setSelectedEdge(null)
  }, [])

  // Whatever is selected has already framed the question, so the panel opens
  // with it filled in. An edge frames it completely: both ends and a port.
  const prefill = useMemo<Prefill | undefined>(() => {
    const endpointFor = (n: GraphNode | undefined) => {
      if (!n) return undefined
      if (n.kind === 'workload') {
        return {
          text: `${n.namespace}/${n.label}`,
          workload: { namespace: n.namespace ?? '', name: n.label, kind: n.workloadKind },
        }
      }
      return n.kind === 'domain' ? { text: n.label } : undefined
    }

    if (selectedEdge) {
      const port = selectedEdge.ports?.[0]?.match(/^(\d+)/)?.[1]
      return {
        from: endpointFor(nodesById.get(selectedEdge.source)),
        to: endpointFor(nodesById.get(selectedEdge.target)),
        port: port ? Number(port) : undefined,
      }
    }
    if (selectedNode) return { from: endpointFor(selectedNode) }
    return undefined
  }, [selectedEdge, selectedNode, nodesById])

  const totalUnprotected = namespaces.reduce((sum, ns) => sum + ns.unprotected, 0)
  const empty = !syncing && !error && filtered && filtered.nodes.length === 0

  // Held over the whole shell rather than over the canvas, so it continues the
  // boot screen instead of framing a half-drawn dashboard behind it.
  if (syncing && !graph && !error) {
    return (
      <Splash
        status="Syncing cluster state"
        detail="Reading namespaces, workloads and policies. This takes a moment on first start."
      />
    )
  }

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <AppHeader
          meta={meta}
          connected={connected}
          unprotected={totalUnprotected}
          theme={theme}
          onToggleTheme={() => {
            const next = theme === 'dark' ? 'light' : 'dark'
            applyTheme(next)
            setTheme(next)
          }}
          onOpenSearch={() => setPaletteOpen(true)}
          onOpenSimulate={() => setSimulateOpen(true)}
        />

        <div className="flex min-h-0 flex-1">
          <FilterRail
            namespaces={namespaces}
            selectedNamespaces={selectedNs}
            onToggleNamespace={toggleNamespace}
            onClearNamespaces={() => setSelectedNs([])}
            level={level}
            onLevel={setLevel}
            includeDefault={includeDefault}
            onIncludeDefault={setIncludeDefault}
            animateFlow={animateFlow}
            onAnimateFlow={setAnimateFlow}
            showGroups={showGroups}
            onShowGroups={setShowGroups}
            filters={filters}
            onFilters={setFilters}
            workloadKinds={workloadKinds}
            palette={palette}
            hidden={hidden}
            onReset={() => {
              setFilters(defaultFilters())
              setIncludeDefault(true)
            }}
          />

          <main className="relative min-w-0 flex-1 overflow-hidden bg-canvas">
            <div className="canvas-texture pointer-events-none absolute inset-0 opacity-50" />
            <div className="canvas-vignette pointer-events-none absolute inset-0" />

            {filtered && (
              <GraphCanvas
                data={filtered}
                palette={palette}
                theme={theme}
                animateFlow={animateFlow}
                showGroups={showGroups}
                selectedId={selectedEdge?.id ?? selectedNode?.id ?? null}
                focusId={focusId}
                viewToken={viewToken}
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

            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-end justify-between p-3.5">
              <div className="pointer-events-auto">
                <Legend />
              </div>
              {/* Given a backdrop: the canvas extends underneath, and bare text
                  over a node label is unreadable for both. */}
              <p className="glass rim hidden items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] text-faint md:flex">
                <Kbd>⌘K</Kbd> search
                <span className="opacity-40">·</span>
                <Kbd>esc</Kbd> close
                <span className="opacity-40">·</span>
                click an edge for the rule behind it
              </p>
            </div>

            {graph?.truncated && (
              <div className="glass rim pointer-events-none absolute top-3.5 left-1/2 z-10 -translate-x-1/2 rounded-full border border-warn/40 px-3.5 py-1.5 text-[12px] text-muted">
                Some peers matched more workloads than can be drawn and were collapsed to their
                namespace.
              </div>
            )}


            {error && (
              <Overlay icon={TriangleAlert} title="Could not reach the API">
                <p>{error}</p>
                <p className="mt-2 text-faint">Marsad is read-only, so this is safe to retry.</p>
              </Overlay>
            )}

            {empty && (
              <Overlay icon={hidden > 0 ? ShieldOff : Telescope} title="Nothing to draw">
                {hidden > 0
                  ? 'Every node is hidden by the current filters.'
                  : selectedNs.length > 0
                    ? 'No workloads in the selected namespaces.'
                    : 'This cluster has no workloads Marsad can see.'}
              </Overlay>
            )}

            <Inspector
              node={selectedNode}
              edge={selectedEdge}
              nodesById={nodesById}
              onClose={() => {
                setSelectedNode(null)
                setSelectedEdge(null)
              }}
            />
          </main>
        </div>

        <SimulatePanel
          open={simulateOpen}
          onOpenChange={setSimulateOpen}
          prefill={prefill}
        />

        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          nodes={filtered?.nodes ?? []}
          namespaces={namespaces}
          onSelectNode={focusNode}
          onSelectNamespace={toggleNamespace}
          onSimulate={() => setSimulateOpen(true)}
        />
      </div>
    </TooltipProvider>
  )
}
