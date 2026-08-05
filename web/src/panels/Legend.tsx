/** The graph uses colour and shape to mean things; saying which is cheaper than
 * making people infer it. Kept small and out of the way. */
export function Legend({ level }: { level: 'namespace' | 'workload' }) {
  return (
    <div className="legend glass">
      <div className="cols">
        <div>
          <h4>Edges</h4>
          <div className="row">
            <span className="line" style={{ borderTop: '2.5px solid var(--allowed)' }} />
            allowed by a rule
          </div>
          <div className="row">
            <span className="line" style={{ borderTop: '1px solid var(--default)' }} />
            allowed by default
          </div>
          <div className="row">
            <span className="line" style={{ borderTop: '2.5px solid var(--approx)' }} />
            depends on DNS
          </div>
        </div>

        <div>
          <h4>Nodes</h4>
          <div className="row">
            {/* Cluster nodes take a hue from their namespace, so the legend
                shows the idea rather than one arbitrary colour. */}
            <span
              className="swatch"
              style={{
                background:
                  'linear-gradient(135deg, hsl(210 55% 58%), hsl(140 55% 58%), hsl(280 55% 58%))',
              }}
            />
            {level === 'namespace' ? 'namespace' : 'workload'} · colour by namespace
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
            <span
              className="swatch"
              style={{ background: 'transparent', boxShadow: '0 0 0 2.5px var(--danger) inset' }}
            />
            red ring · no policy selects it
          </div>
        </div>
      </div>
    </div>
  )
}
