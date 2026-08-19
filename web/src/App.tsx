import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ShieldOff, Telescope, TriangleAlert } from 'lucide-react'

import { Button } from './components/ui/button'

import {
  NotReadyError,
  fetchGraph,
  fetchHealth,
  fetchMeta,
  fetchNamespaces,
  openStream,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type Level,
  type Meta,
  type NamespaceSummary,
  type StreamHandle,
  type StreamStatus,
  type SyncStep,
  type Fault,
} from './api'
import { AppHeader } from './components/AppHeader'
import { CanvasBar } from './components/CanvasBar'
import { ClusterFault } from './components/ClusterFault'
import { CommandPalette } from './components/CommandPalette'
import { EdgePopover } from './components/EdgePopover'
import { FilterRail } from './components/FilterRail'
import { GraphCanvas, type GraphControls } from './components/GraphCanvas'
import { Inspector } from './components/Inspector'
import { Minimap } from './components/Minimap'
import { Splash } from './components/Splash'
import { SimulatePanel, type Prefill } from './components/SimulatePanel'
import { TooltipProvider } from './components/ui/tooltip'
import { buildNamespacePalette } from './graph/style'
import {
  applyFilters,
  defaultFilters,
  edgeKindCounts,
  hiddenCount,
  isHiding,
  presentWorkloadKinds,
  workloadCounts,
  type Filters,
} from './lib/filters'

type Theme = 'dark' | 'light'

const STORED_THEME = 'marsad.theme'
const prefersLight = () => window.matchMedia('(prefers-color-scheme: light)').matches

/** What the OS asked for, used until the viewer says otherwise. */
function systemTheme(): Theme {
  return prefersLight() ? 'light' : 'dark'
}

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
}

/**
 * Written only when the viewer picks one.
 *
 * Storing the OS preference on first load would pin it forever: someone whose
 * machine turns light at sunrise would keep getting the dark theme because
 * Marsad recorded an answer they never gave.
 */
function persistTheme(theme: Theme) {
  localStorage.setItem(STORED_THEME, theme)
}

const stored = localStorage.getItem(STORED_THEME) as Theme | null
const initialTheme: Theme = stored ?? systemTheme()
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
  const [status, setStatus] = useState<StreamStatus>({
    state: 'reconnecting',
    updatedAt: null,
    retryAt: null,
    attempt: 0,
  })
  const stream = useRef<StreamHandle | null>(null)
  /** Sync progress, polled only while the caches are still filling. */
  const [progress, setProgress] = useState<SyncStep[]>([])
  /** Why the cluster cannot be read, if it cannot. */
  const [fault, setFault] = useState<{ fault: Fault; clusterRole?: string } | null>(null)

  const [level, setLevel] = useState<Level>('namespace')
  const [selectedNs, setSelectedNs] = useState<string[]>([])
  const [includeDefault, setIncludeDefault] = useState(true)
  const [filters, setFilters] = useState<Filters>(defaultFilters)
  const [animateFlow, setAnimateFlow] = useState(true)
  const [showGroups, setShowGroups] = useState(true)

  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [pinnedTheme, setPinnedTheme] = useState(stored !== null)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null)
  /** Where the pointer landed, so the popover is anchored to the click. */
  const [edgeAt, setEdgeAt] = useState<{ x: number; y: number } | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  /** The node the *server* is reducing the graph around, distinct from focusId,
   * which only aims the camera. One changes what is drawn; the other changes
   * where you are looking at it from. */
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [simulateOpen, setSimulateOpen] = useState(false)

  const query = useMemo(
    () => ({
      level,
      namespaces: selectedNs,
      includeDefault,
      focus: focusNodeId ?? undefined,
    }),
    [level, selectedNs, includeDefault, focusNodeId],
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
    const handle = openStream(
      query,
      (msg) => {
        if (msg.graph) {
          setGraph(msg.graph)
          setSyncing(false)
        }
        void loadSummaries()
      },
      setStatus,
    )
    stream.current = handle
    return () => {
      handle.close()
      if (stream.current === handle) stream.current = null
    }
  }, [query, loadSummaries])

  // Polled only while there is nothing to draw. /api/health is the one endpoint
  // that answers during cache sync, and once it stops mattering the polling
  // stops with it.
  useEffect(() => {
    let cancelled = false
    const tick = () =>
      void fetchHealth()
        .then((h) => {
          if (cancelled) return
          setProgress(h.progress ?? [])
          setFault(h.fault ? { fault: h.fault, clusterRole: h.clusterRole } : null)
        })
        .catch(() => {})
    tick()
    // Fast while there is nothing to show, slow once there is: the commonest
    // permission failure is found by a watch well after startup, so this cannot
    // stop entirely — but it does not need to run every second forever.
    const t = window.setInterval(tick, syncing ? 900 : 15_000)
    return () => {
      cancelled = true
      window.clearInterval(t)
    }
  }, [syncing])

  // Follow the OS until the viewer picks a side. Someone who has never touched
  // the toggle should see the machine turn light at sunrise, not stay dark
  // because Marsad recorded a preference on their behalf.
  useEffect(() => {
    if (pinnedTheme) return
    const query = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => {
      const next = systemTheme()
      applyTheme(next)
      setTheme(next)
    }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [pinnedTheme])

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
      // F reduces the graph to what surrounds the selection. On a cluster with
      // 200 workloads the whole picture is not a picture, and this is the way
      // back to one.
      if (e.key === 'f' && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        setFocusNodeId((cur) => (cur ? null : (selectedNode?.id ?? null)))
      }
      if (e.key === 'Escape' && !typing) {
        setSelectedNode(null)
        setSelectedEdge(null)
        setEdgeAt(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedNode])

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
        filters.onlyExposed,
        focusNodeId ?? '',
        filters.hideIsolatedNodes,
        filters.hideDNS,
        [...filters.workloadKinds].sort().join(','),
        [...filters.edgeKinds].sort().join(','),
      ].join('|'),
    [level, includeDefault, selectedNs, filters, focusNodeId],
  )
  const hidden = graph && filtered ? hiddenCount(graph, filtered) : 0
  const workloadKinds = useMemo(() => presentWorkloadKinds(graph), [graph])
  const edgeCounts = useMemo(() => edgeKindCounts(graph, includeDefault), [graph, includeDefault])
  const counts = useMemo(() => workloadCounts(graph, filtered), [graph, filtered])
  const hiding = isHiding(graph, filtered, includeDefault)
  const graphControls = useRef<GraphControls | null>(null)

  const toggleOnlyUnprotected = useCallback(() => {
    setFilters((f) => ({ ...f, onlyUnprotected: !f.onlyUnprotected }))
  }, [])

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
  // The one empty screen that is a finding rather than a void.
  const noPolicies = meta?.counts.policies === 0

  // Held over the whole shell rather than over the canvas, so it continues the
  // boot screen instead of framing a half-drawn dashboard behind it.
  if (fault) {
    return (
      <TooltipProvider>
        <div className="relative h-full">
          <ClusterFault fault={fault.fault} clusterRole={fault.clusterRole} />
        </div>
      </TooltipProvider>
    )
  }

  if (syncing && !graph && !error) {
    return (
      <Splash progress={progress} />
    )
  }

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <AppHeader
          meta={meta}
          status={status}
          onReconnect={() => stream.current?.reconnect()}
          unprotected={totalUnprotected}
          onlyUnprotected={filters.onlyUnprotected}
          onToggleUnprotected={toggleOnlyUnprotected}
          theme={theme}
          onToggleTheme={() => {
            const next = theme === 'dark' ? 'light' : 'dark'
            applyTheme(next)
            persistTheme(next)
            setPinnedTheme(true)
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
            edgeCounts={edgeCounts}
            shown={counts.shown}
            total={counts.total}
            hiding={hiding}
            onReset={() => {
              setFilters(defaultFilters())
              setIncludeDefault(true)
            }}
          />

          {/* A column, so the bar along the bottom is part of the layout rather
              than floating over the picture it is describing. */}
          <main className="flex min-w-0 flex-1 flex-col bg-canvas">
            <div className="relative min-h-0 flex-1 overflow-hidden">
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
                  controls={graphControls}
                  onSelectNode={(n) => {
                    setSelectedNode(n)
                    setSelectedEdge(null)
                  }}
                  onSelectEdge={(e, at) => {
                    setSelectedEdge(e)
                    setEdgeAt(at)
                    setSelectedNode(null)
                  }}
                  onClearSelection={() => {
                    setSelectedNode(null)
                    setSelectedEdge(null)
                    setEdgeAt(null)
                  }}
                />
              )}

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

              {/* Drawing a tenth of a cluster without saying so is worse than
                  drawing all of it. The counts come from the build, not from
                  what survived the filters. */}
              {graph?.focus && (
                <div className="glass rim absolute top-3.5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2.5 rounded-full border border-accent/40 px-3.5 py-1.5 text-[12px]">
                  <span className="text-text-body">
                    Focused on{' '}
                    <span className="font-medium text-fg">
                      {nodesById.get(graph.focus.node)?.label ?? graph.focus.node}
                    </span>
                    <span className="px-1.5 opacity-50">·</span>
                    <span className="num">{graph.focus.hops}</span> hops
                    <span className="px-1.5 opacity-50">·</span>
                    <span className="num">{graph.focus.namespaces}</span> of{' '}
                    <span className="num">{graph.focus.totalNamespaces}</span> namespaces drawn
                  </span>
                  <Button size="sm" variant="outline" onClick={() => setFocusNodeId(null)}>
                    Clear focus
                  </Button>
                </div>
              )}

              {/* Refused, and says why. Drawing it would produce a hairball no
                  amount of panning recovers, and letting somebody discover that
                  for themselves is not a kindness. */}
              {graph?.oversize && (
                <Overlay icon={Telescope} title="Too much to draw at once">
                  <p>
                    This view has <span className="num">{graph.oversize.nodes}</span> nodes. Past
                    about <span className="num">{graph.oversize.limit}</span> a node-link diagram
                    stops being readable, so Marsad has not drawn one — the picture would be the
                    problem, not the answer.
                  </p>
                  <div className="mt-3.5 flex justify-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => setPaletteOpen(true)}>
                      Search for a workload
                    </Button>
                    {level === 'workload' && (
                      <Button size="sm" variant="ghost" onClick={() => setLevel('namespace')}>
                        Show namespaces instead
                      </Button>
                    )}
                  </div>
                </Overlay>
              )}

              {/* A stale graph looks exactly like a live one, so when the stream
                  is not live the canvas says so rather than leaving the header
                  badge to carry it alone. */}
              {status.state !== 'live' && graph && (
                <div className="glass rim absolute top-3.5 left-1/2 z-20 flex max-w-[46rem] -translate-x-1/2 items-start gap-2.5 rounded-xl border border-danger/40 px-3.5 py-2.5">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="text-[12.5px] text-text-body">
                      Live updates stopped.{' '}
                      {status.updatedAt ? (
                        <>
                          What you see is the snapshot taken at{' '}
                          <span className="num">{status.updatedAt.toLocaleTimeString()}</span>, so it
                          may no longer match the cluster.
                        </>
                      ) : (
                        'Nothing has arrived over the stream yet, so this may already be out of date.'
                      )}
                    </p>
                    <div className="mt-1.5 flex gap-1.5">
                      <Button size="sm" variant="outline" onClick={() => stream.current?.reconnect()}>
                        Reconnect
                      </Button>
                      {status.state === 'reconnecting' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => stream.current?.keepSnapshot()}
                        >
                          Keep viewing snapshot
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* A cluster with no policies is not an empty screen. It is the
                  strongest finding Marsad can report, and framing it as a void
                  buries it. */}
              {empty && noPolicies && (
                <Overlay icon={ShieldOff} title="No network policies at all">
                  <p>
                    Every workload can reach every other workload, and anything outside the cluster.
                    There is nothing for Marsad to draw — which is itself the finding.
                  </p>
                  <div className="mt-3.5 flex justify-center">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setFilters(defaultFilters())
                        setIncludeDefault(true)
                        setSelectedNs([])
                        setLevel('workload')
                      }}
                    >
                      Show all {meta?.counts.workloads ?? 0} workloads
                    </Button>
                  </div>
                </Overlay>
              )}

              {empty && !noPolicies && (
                <Overlay
                  icon={hidden > 0 ? ShieldOff : Telescope}
                  title={hidden > 0 ? 'No workload matches these filters' : 'Nothing to draw'}
                >
                  {hidden > 0 ? (
                    <>
                      <p>The cluster is fine — the filter is too narrow.</p>
                      <div className="mt-3.5 flex justify-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setFilters(defaultFilters())
                            setIncludeDefault(true)
                          }}
                        >
                          Clear filters
                        </Button>
                        {selectedNs.length > 0 && (
                          <Button size="sm" variant="ghost" onClick={() => setSelectedNs([])}>
                            Clear namespace selection
                          </Button>
                        )}
                      </div>
                    </>
                  ) : selectedNs.length > 0 ? (
                    <>
                      <p>No workloads in the selected namespaces.</p>
                      <div className="mt-3.5 flex justify-center">
                        <Button size="sm" variant="outline" onClick={() => setSelectedNs([])}>
                          Clear namespace selection
                        </Button>
                      </div>
                    </>
                  ) : (
                    <p>This cluster has no workloads Marsad can see.</p>
                  )}
                </Overlay>
              )}

              {/* Only when there is enough graph for "where am I" to be a
                  question worth answering. */}
              {filtered && filtered.nodes.length > 12 && <Minimap controls={graphControls} />}

              <Inspector
                node={selectedNode}
                onClose={() => setSelectedNode(null)}
                onSimulate={() => setSimulateOpen(true)}
              />

              {selectedEdge && edgeAt && (
                <EdgePopover
                  edge={selectedEdge}
                  at={edgeAt}
                  source={nodesById.get(selectedEdge.source)}
                  target={nodesById.get(selectedEdge.target)}
                  onClose={() => {
                    setSelectedEdge(null)
                    setEdgeAt(null)
                  }}
                  onOpenNode={(n) => {
                    setSelectedEdge(null)
                    setEdgeAt(null)
                    setSelectedNode(n)
                  }}
                />
              )}
            </div>

            <CanvasBar
              onZoomIn={() => graphControls.current?.zoomIn()}
              onZoomOut={() => graphControls.current?.zoomOut()}
              onFit={() => graphControls.current?.fit()}
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
