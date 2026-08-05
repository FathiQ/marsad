import { Info } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Button } from './ui/button'

/** The graph uses colour and shape to mean things; saying which is cheaper than
 * making people infer it. Tucked into a popover so it explains on demand rather
 * than permanently occupying a corner of the canvas. */
export function Legend() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Info className="size-3.5" />
          Legend
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3.5">
        <div className="space-y-3.5">
          <div className="space-y-1.5">
            <h4 className="text-[10.5px] font-semibold tracking-[0.07em] text-faint uppercase">
              Connections
            </h4>
            {[
              ['var(--allowed)', 3, 'allowed by a rule'],
              ['var(--neutral-edge)', 1, 'allowed by default — nothing isolates it'],
              ['var(--approx)', 3, 'depends on DNS at runtime'],
            ].map(([colour, weight, label]) => (
              <div key={label as string} className="flex items-center gap-2.5 text-[11.5px] text-muted">
                <span
                  className="w-6 shrink-0 rounded-full"
                  style={{ height: weight as number, background: colour as string }}
                />
                {label}
              </div>
            ))}
            <p className="pt-1 text-[11px] leading-relaxed text-faint">
              Dots trace the direction a path is <em>permitted</em> in — briskly where a rule opened
              it, slowly where nothing closed it. Marsad reads declared policy and never observes
              traffic.
            </p>
          </div>

          <div className="space-y-1.5">
            <h4 className="text-[10.5px] font-semibold tracking-[0.07em] text-faint uppercase">
              Nodes
            </h4>
            {[
              [
                'linear-gradient(135deg, oklch(0.72 0.15 255), oklch(0.72 0.15 155), oklch(0.72 0.15 305))',
                'cluster node — colour by namespace',
              ],
              ['var(--node-domain)', 'domain'],
              ['var(--node-cidr)', 'CIDR'],
            ].map(([bg, label]) => (
              <div key={label} className="flex items-center gap-2.5 text-[11.5px] text-muted">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: bg }} />
                {label}
              </div>
            ))}
            <div className="flex items-center gap-2.5 text-[11.5px] text-muted">
              <span className="size-2.5 shrink-0 rounded-full ring-2 ring-danger ring-inset" />
              red ring — no policy selects it
            </div>
            <p className="pt-1 text-[11px] leading-relaxed text-faint">
              The icon shows the workload kind; size grows with replicas, or with how many workloads
              a namespace holds.
            </p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
