import { Check, Loader2 } from 'lucide-react'

import type { SyncStep } from '../api'
import { Mark } from './Mark'

/**
 * What Marsad shows before it can show anything else.
 *
 * The same arrangement is written statically into index.html so that it paints
 * on the first frame, before the bundle has parsed. Keeping the two in step
 * means the handover from the boot screen to this one is invisible: only what
 * is underneath changes. If you move something here, move it there.
 *
 * The steps are real. Waiting for informer caches is the slowest thing Marsad
 * does on a large cluster, and a bar that says nothing for forty seconds is
 * indistinguishable from one that is stuck — so /api/health reports how far each
 * group has got, and this shows it. The counts are what has arrived so far
 * rather than totals, which is why an unfinished line says "so far".
 */
export function Splash({ progress }: { progress?: SyncStep[] }) {
  const steps = progress ?? []

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-bg px-6">
      <div className="flex -translate-y-4 flex-col items-center text-center">
        <Mark className="size-[72px] text-fg" />

        <h1 className="mt-4 text-[30px] leading-none font-semibold tracking-[-0.025em]">Marsad</h1>

        <p className="mt-2.5 text-[12.5px] text-text-dim">Reading your cluster</p>

        {/* An indeterminate bar rather than a spinner: it says "still working"
            without pretending to know how far along it is. The steps below are
            where the actual progress lives. */}
        <div className="mt-7 h-[2px] w-[150px] overflow-hidden rounded-full bg-line">
          <div className="splash-sweep h-full w-1/3 rounded-full bg-accent" />
        </div>

        {steps.length > 0 && (
          <ul className="mt-6 space-y-1.5 text-left">
            {steps.map((step) => (
              <li key={step.name} className="flex items-center gap-2 text-[12px]">
                {step.synced ? (
                  <Check className="size-3.5 shrink-0 text-allowed-text" aria-hidden="true" />
                ) : (
                  <Loader2
                    className="size-3.5 shrink-0 animate-spin text-text-dim"
                    aria-hidden="true"
                  />
                )}
                <span className={step.synced ? 'text-text-body' : 'text-text-dim'}>
                  <span className="num">{step.count}</span> {step.name}
                  {!step.synced && <span className="text-text-dim"> so far</span>}
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* Said here rather than in the docs, because this is the first screen
            anyone sees and "what is this about to do to my cluster" is the first
            question a tool pointed at production has to answer. */}
        <p className="mt-7 max-w-xs text-[11.5px] leading-relaxed text-text-dim">
          Read-only. Marsad lists and watches; it never writes.
        </p>
      </div>
    </div>
  )
}
