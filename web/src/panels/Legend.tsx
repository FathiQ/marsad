/** The graph uses colour to mean things; saying which is cheaper than making
 * people infer it. Kept small and out of the way. */
export function Legend({ level }: { level: 'namespace' | 'workload' }) {
  return (
    <div className="legend">
      <h4>Edges</h4>
      <div className="row">
        <span className="line" style={{ borderTop: '2px solid var(--allowed)' }} />
        explicitly allowed by a rule
      </div>
      <div className="row">
        <span className="line" style={{ borderTop: '1px solid var(--default)' }} />
        allowed by default — nothing isolates it
      </div>
      <div className="row">
        <span className="line" style={{ borderTop: '2px solid var(--approx)' }} />
        approximate — depends on DNS at runtime
      </div>

      <h4 style={{ marginTop: 9 }}>Nodes</h4>
      <div className="row">
        <span
          className="swatch"
          style={{ background: level === 'namespace' ? 'var(--node-namespace)' : 'var(--node-workload)' }}
        />
        {level === 'namespace' ? 'namespace' : 'workload'}
      </div>
      <div className="row">
        <span className="swatch" style={{ background: 'var(--node-domain)' }} />
        domain
      </div>
      <div className="row">
        <span className="swatch" style={{ background: 'var(--node-cidr)' }} />
        CIDR
      </div>
      <div className="row">
        <span className="swatch" style={{ background: 'var(--danger)' }} />
        no policy selects it
      </div>
    </div>
  )
}
