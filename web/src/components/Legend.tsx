import { Info, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from './ui/button'

/**
 * The graph uses colour, shape and motion to mean things; saying which is
 * cheaper than making people infer it.
 *
 * Deliberately not a Radix popover. This is a static panel pinned to a known
 * corner, and the portalled floating-ui positioning a popover brings was placing
 * it 684 pixels above the viewport — off-screen, so pressing the button appeared
 * to do nothing at all. A panel positioned by the layout that owns the corner
 * cannot land anywhere else, and there is no collision maths to get wrong.
 */
export function Legend() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }

    window.addEventListener('keydown', onKey)
    // Deferred by a tick: the click that opened the panel would otherwise be the
    // one that closes it again.
    const timer = window.setTimeout(() => window.addEventListener('mousedown', onClick), 0)

    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
      window.clearTimeout(timer)
    }
  }, [open])

  return (
    <div className="relative" ref={ref}>
      {open && (
        <div
          role="dialog"
          aria-label="Legend"
          className="absolute bottom-full left-0 mb-2 w-[21rem] rounded-xl border border-line bg-elevated p-3.5 shadow-2xl"
        >
          <div className="space-y-3.5">
            <section className="space-y-1.5">
              <div className="flex items-center justify-between">
                <h4 className="text-[10.5px] font-semibold tracking-[0.07em] text-faint uppercase">
                  Connections
                </h4>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setOpen(false)}
                  aria-label="Close legend"
                >
                  <X />
                </Button>
              </div>

              {(
                [
                  ['var(--allowed)', 3, 'allowed by a rule'],
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

              <div className="flex items-center gap-2.5 text-[11.5px] text-muted">
                <span className="w-6 shrink-0 text-center text-[11px] text-danger">→</span>
                open from / to anything — no policy isolates it
              </div>
              <p className="pt-1 text-[11px] leading-relaxed text-faint">
                Traffic permitted only because nothing forbids it is shown on the card, not as a
                line: every unprotected workload would otherwise draw two edges to one node and
                bury the rules somebody actually wrote. Dots trace the direction a path is{' '}
                <em>permitted</em> in. Marsad reads declared policy and never observes traffic.
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
                <span className="shrink-0 rounded-full border border-line bg-surface px-1.5 text-[10px]">
                  3
                </span>
                replicas, or workloads in a namespace
              </div>
              <p className="pt-1 text-[11px] leading-relaxed text-faint">
                Rows beneath a name are its <em>access points</em> — the ports it accepts. An edge
                ends on the port it reaches, so a line says which door it goes through.
              </p>
            </section>
          </div>
        </div>
      )}

      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Info className="size-3.5" />
        Legend
      </Button>
    </div>
  )
}
