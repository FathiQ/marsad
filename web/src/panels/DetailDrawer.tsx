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

/** Renders one allow entry, including the rules that produced it. That trace is
 * the feature the whole tool exists for, so it is never collapsed away. */
function AllowRow({ allow }: { allow: Allow }) {
  return (
    <div className="rule">
      <div className="peer">{allow.peer.display}</div>
      <div className="ports">{portText(allow.ports)}</div>
      {allow.note && <div className="note">{allow.note}</div>}
      <div className="via">
        {allow.via.map((v) => (
          <code key={v}>{v}</code>
        ))}
      </div>
    </div>
  )
}

function EffectiveSection({ title, eff }: { title: string; eff: Effective }) {
  if (!eff.isolated) {
    return (
      <div className="section">
        <h4>{title}</h4>
        <p className="empty">
          No policy applies {title.toLowerCase()} rules here, so everything is allowed by default.
        </p>
      </div>
    )
  }

  return (
    <div className="section">
      <h4>
        {title} <span className="badge ok">isolated</span>
      </h4>

      {(eff.allows?.length ?? 0) === 0 ? (
        <p className="empty">Isolated with no matching rules — all {title.toLowerCase()} denied.</p>
      ) : (
        eff.allows?.map((a, i) => <AllowRow key={i} allow={a} />)
      )}

      {/* Layers are shown separately whenever more than one provider governs the
          workload, because the combined view is an interpretation and the raw
          per-provider truth is not. */}
      {(eff.layers?.length ?? 0) > 1 && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-dim)' }}>
            Per-provider layers ({eff.layers?.length})
          </summary>
          <div style={{ marginTop: 8 }}>
            {eff.layers?.map((l) => (
              <div key={l.provider} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>
                  <span className="chip">{l.provider}</span>{' '}
                  {l.by?.map((b) => b.name).join(', ')}
                </div>
                {l.allows?.map((a, i) => <AllowRow key={i} allow={a} />)}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

function EdgeDetail({ edge, nodesById }: { edge: GraphEdge; nodesById: Map<string, GraphNode> }) {
  const source = nodesById.get(edge.source)
  const target = nodesById.get(edge.target)

  return (
    <>
      <div className="section">
        <h4>Traffic</h4>
        <dl className="kv">
          <dt>From</dt>
          <dd>{source?.label ?? edge.source}</dd>
          <dt>To</dt>
          <dd>{target?.label ?? edge.target}</dd>
          <dt>Ports</dt>
          <dd className="mono">{edge.ports?.length ? edge.ports.join(', ') : 'all ports'}</dd>
          <dt>Kind</dt>
          <dd>
            {edge.kind === 'allowed' && <span className="badge ok">explicitly allowed</span>}
            {edge.kind === 'default' && <span className="badge">allowed by default</span>}
            {edge.kind === 'approximate' && <span className="badge warn">approximate</span>}
          </dd>
        </dl>
        {edge.note && (
          <p className="note" style={{ marginTop: 8, color: 'var(--warn)', fontSize: 12.5 }}>
            {edge.note}
          </p>
        )}
      </div>

      <div className="section">
        <h4>Produced by</h4>
        {edge.via.length === 0 ? (
          <p className="empty">
            Nothing produced this edge — it exists because no policy isolates the workload.
          </p>
        ) : (
          <div className="rule">
            {edge.via.map((v) => (
              <code key={v} style={{ display: 'block', wordBreak: 'break-all', marginBottom: 3 }}>
                {v}
              </code>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function WorkloadBody({ detail }: { detail: WorkloadDetail }) {
  const { workload, isolation, policies } = detail
  return (
    <>
      <div className="section">
        <h4>Posture</h4>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          <span className={`badge ${isolation.ingress ? 'ok' : 'bad'}`}>
            ingress {isolation.ingress ? 'isolated' : 'open'}
          </span>
          <span className={`badge ${isolation.egress ? 'ok' : 'bad'}`}>
            egress {isolation.egress ? 'isolated' : 'open'}
          </span>
        </div>
        <dl className="kv">
          <dt>Kind</dt>
          <dd>{workload.kind}</dd>
          <dt>Replicas</dt>
          <dd>{workload.replicas}</dd>
          {workload.ports?.length ? (
            <>
              <dt>Ports</dt>
              <dd className="mono">
                {workload.ports.map((p) => `${p.name}=${p.port}/${p.protocol}`).join(', ')}
              </dd>
            </>
          ) : null}
        </dl>
        {workload.labels && Object.keys(workload.labels).length > 0 && (
          <div className="chips" style={{ marginTop: 8 }}>
            {Object.entries(workload.labels).map(([k, v]) => (
              <span className="chip" key={k}>
                {k}={v}
              </span>
            ))}
          </div>
        )}
      </div>

      <EffectiveSection title="Ingress" eff={detail.ingress} />
      <EffectiveSection title="Egress" eff={detail.egress} />

      <div className="section">
        <h4>Applied policies ({policies?.length ?? 0})</h4>
        {!policies?.length ? (
          <p className="empty">
            No policy selects this workload. It is reachable from anywhere and can reach anywhere.
          </p>
        ) : (
          policies.map((p) => (
            <details className="policy" key={`${p.ref.namespace}/${p.ref.name}/${p.provider}`}>
              <summary>
                <span className="nm">{p.ref.name}</span>
                <span className="chip">{p.types}</span>
                <span className="chip">{p.provider}</span>
              </summary>
              {/* Read-only viewer: Marsad never writes, and the drawer should
                  not look like somewhere you could. */}
              <pre className="yaml">{p.yaml ?? '# original object unavailable'}</pre>
            </details>
          ))
        )}
      </div>
    </>
  )
}

export function DetailDrawer({ node, edge, nodesById, onClose }: Props) {
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

  if (!node && !edge) return null

  const title = edge ? 'Edge' : (node?.label ?? '')
  const subtitle = edge
    ? `${nodesById.get(edge.source)?.label ?? edge.source} → ${nodesById.get(edge.target)?.label ?? edge.target}`
    : [node?.namespace, node?.workloadKind ?? node?.kind].filter(Boolean).join(' · ')

  return (
    <div className="drawer" role="dialog" aria-label="Details">
      <div className="drawer-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3>{title}</h3>
          <div className="sub">{subtitle}</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close details ( Esc )">
          ✕
        </button>
      </div>

      <div className="drawer-body">
        {edge && <EdgeDetail edge={edge} nodesById={nodesById} />}

        {node && !edge && (
          <>
            {loading && <p className="empty">Loading…</p>}
            {error && (
              <p className="empty" style={{ color: 'var(--danger)' }}>
                {error}
              </p>
            )}
            {detail && <WorkloadBody detail={detail} />}

            {node.kind === 'namespace' && (
              <div className="section">
                <h4>Namespace</h4>
                <dl className="kv">
                  <dt>Workloads</dt>
                  <dd>{node.workloads ?? 0}</dd>
                  <dt>Unprotected</dt>
                  <dd style={{ color: (node.unprotected ?? 0) > 0 ? 'var(--danger)' : undefined }}>
                    {node.unprotected ?? 0}
                  </dd>
                </dl>
                <p className="empty" style={{ marginTop: 10 }}>
                  Switch to workload level, or select this namespace in the sidebar, to expand it.
                </p>
              </div>
            )}

            {['cidr', 'world', 'domain', 'any'].includes(node.kind) && (
              <div className="section">
                <h4>External peer</h4>
                <dl className="kv">
                  <dt>Kind</dt>
                  <dd>{node.kind}</dd>
                  <dt>Value</dt>
                  <dd className="mono">{node.label}</dd>
                </dl>
                <p className="empty" style={{ marginTop: 10 }}>
                  {node.kind === 'any'
                    ? 'Matched by rules with no from/to list — literally anything, in or out of the cluster.'
                    : 'Click an edge touching this node to see which rule allows it.'}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
