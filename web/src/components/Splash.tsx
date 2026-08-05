import { Mark } from './Mark'

/**
 * What Marsad shows before it can show anything else.
 *
 * The same arrangement is written statically into index.html so that it paints
 * on the first frame, before the bundle has parsed. Keeping the two in step
 * means the handover from the boot screen to this one is invisible: only the
 * status line underneath changes. If you move something here, move it there.
 */
export function Splash({ status, detail }: { status: string; detail?: string }) {
  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-bg px-6">
      <div className="flex -translate-y-4 flex-col items-center text-center">
        <Mark className="size-[72px] text-fg" />

        <h1 className="mt-4 text-[30px] leading-none font-semibold tracking-[-0.025em]">Marsad</h1>

        <p className="mt-2.5 text-[12.5px] text-faint">
          the observatory for your Kubernetes network policies
        </p>

        {/* An indeterminate bar rather than a spinner: it says "still working"
            without pretending to know how far along it is. */}
        <div className="mt-7 h-[2px] w-[150px] overflow-hidden rounded-full bg-line">
          <div className="splash-sweep h-full w-1/3 rounded-full bg-accent" />
        </div>

        <p className="mt-3.5 text-[12px] text-muted">{status}</p>
        {detail && <p className="mt-1 max-w-xs text-[11.5px] leading-relaxed text-faint">{detail}</p>}
      </div>
    </div>
  )
}
