import { Info } from 'lucide-react'

import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

/** The graph uses colour, shape and motion to mean things; saying which is
 * cheaper than making people infer it. Kept in a popover so it explains on
 * demand rather than permanently occupying a corner of the canvas. */
export function Legend() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Info className="size-3.5" />
          Legend
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[21rem] p-3.5">
        <div className="space-y-3.5">
          <section className="space-y-1.5">
            <h4 className="text-[10.5px] font-semibold tracking-[0.07em] text-faint uppercase">
              Connections
            </h4>
            {(
              [
                ['var(--allowed)', 3, 'allowed by a rule'],
                ['var(--neutral-edge)', 1, 'allowed by default — nothing isolates it'],
                ['var(--approx)', 3, 'depends on DNS at runtime'],
              ] as const
            ).map(([colour, weight, label]) => (
              <div key={label} className="flex items-center gap-2.5 text-[11.5px] text-muted">
                <span
                  className="w-6 shrink-0 rounded-full"
                  style={{ height: weight, background: colour }}
                />
                {label}
              </div>
            ))}
            <p className="pt-1 text-[11px] leading-relaxed text-faint">
              Dots trace the direction a path is <em>permitted</em> in — briskly where a rule opened
              it, slowly where nothing closed it. Marsad reads declared policy and never observes
              traffic.
            </p>
          </section>

          <section className="space-y-1.5">
            <h4 className="text-[10.5px] font-semibold tracking-[0.07em] text-faint uppercase">
              Cards
            </h4>
            <div className="flex items-center gap-2.5 text-[11.5px] text-muted">
              <span
                className="h-4 w-1 shrink-0 rounded-full"
                style={{
                  background:
                    'linear-gradient(180deg, oklch(0.72 0.15 255), oklch(0.72 0.15 155))',
                }}
              />
              the bar on the leading edge is the namespace
            </div>
            <div className="flex items-center gap-2.5 text-[11.5px] text-muted">
              <span className="h-4 w-1 shrink-0 rounded-full bg-danger" />
              red — no policy selects it
            </div>
            <div className="flex items-center gap-2.5 text-[11.5px] text-muted">
              <span className="rounded-full border border-line bg-elevated px-1.5 text-[10px]">
                3
              </span>
              replicas, or workloads in a namespace
            </div>
            <p className="pt-1 text-[11px] leading-relaxed text-faint">
              The kind glyph appears only where kinds differ — repeating it on every card would say
              nothing. Zoom out far enough and cards become dots, so the shape of the cluster stays
              readable.
            </p>
          </section>
        </div>
      </PopoverContent>
    </Popover>
  )
}
