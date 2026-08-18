import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react'

import { Button } from './ui/button'
import { Kbd } from './ui/kbd'
import { Tooltip } from './ui/tooltip'

interface Props {
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
}

/**
 * One bar along the bottom of the canvas, carrying the legend, the keyboard
 * hint and the zoom controls.
 *
 * The legend used to be a button that opened a popover. That put the key to
 * every colour on the screen one click away from a picture whose entire
 * vocabulary is colour — and the click had to be repeated every time someone
 * came back to check. A legend nobody can see is a legend nobody reads, and the
 * cost of showing it permanently is one strip of chrome along an edge that was
 * already occupied by a floating button and a floating hint anyway.
 */

type Entry = {
  label: string
  hint: string
  swatch: React.ReactNode
}

/** A short line in the colour and dash pattern the graph actually draws. */
function Line({ colour, dashed }: { colour: string; dashed?: boolean }) {
  return (
    <svg width="18" height="8" viewBox="0 0 18 8" aria-hidden="true" className="shrink-0">
      <line
        x1="0"
        y1="4"
        x2="18"
        y2="4"
        stroke={colour}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={dashed ? '4 3' : undefined}
      />
    </svg>
  )
}

const ENTRIES: Entry[] = [
  {
    label: 'allowed by a rule',
    // The animation claim lives here because this is the edge that carries it.
    // Marsad reads declared policy and never observes traffic, and a moving dot
    // is exactly the thing a viewer is most likely to read as a packet — so the
    // legend has to say which it is, wherever the legend happens to be.
    hint: 'A policy explicitly permits this traffic, and clicking the edge names the rule. Dots trace the direction a path is permitted in: Marsad reads declared policy and never observes traffic.',
    swatch: <Line colour="var(--allowed)" />,
  },
  {
    label: 'depends on DNS',
    hint: 'Marsad does not resolve DNS, so whether a domain rule covers an address cannot be decided from configuration alone.',
    swatch: <Line colour="var(--approx)" dashed />,
  },
  {
    label: 'allowed by default',
    hint: 'Permitted only because no policy isolates the workload. Stated on the card rather than drawn as a line — every unprotected workload would otherwise draw two edges to one point and bury the rules somebody wrote.',
    // A card edge, not a line: this is stated on the card. No text inside the
    // swatch — it would become part of the entry's accessible name.
    swatch: (
      <span
        className="size-3.5 shrink-0 rounded-[3px] border border-dashed border-neutral-edge"
        aria-hidden="true"
      />
    ),
  },
  {
    label: 'unprotected',
    hint: 'No policy selects this workload at all, so Kubernetes allows everything to and from it.',
    swatch: (
      <span
        className="size-3.5 shrink-0 rounded-[3px] border-2 border-danger"
        aria-hidden="true"
      />
    ),
  },
  {
    label: 'outside the cluster',
    hint: 'An address range or the internet at large — anything that is not a pod Marsad can see.',
    swatch: (
      <span
        className="size-3.5 shrink-0 rounded-full bg-node-world"
        aria-hidden="true"
      />
    ),
  },
]

export function CanvasBar({ onZoomIn, onZoomOut, onFit }: Props) {
  return (
    <div className="pointer-events-auto flex h-10 shrink-0 items-center gap-3 border-t border-line bg-panel px-3">
      <ul
        aria-label="Legend"
        className="flex min-w-0 flex-1 items-center gap-x-4 gap-y-1 overflow-x-auto"
      >
        {ENTRIES.map((entry) => (
          <li key={entry.label} className="shrink-0">
            <Tooltip content={entry.hint}>
              <span className="flex items-center gap-1.5 text-[11px] whitespace-nowrap text-text-dim">
                {entry.swatch}
                {entry.label}
              </span>
            </Tooltip>
          </li>
        ))}
      </ul>

      <p className="hidden items-center gap-1.5 text-[11px] whitespace-nowrap text-text-dim lg:flex">
        <Kbd>⌘K</Kbd> search
        <span className="opacity-40">·</span>
        click an edge for the rule behind it
      </p>

      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip content="Zoom out">
          <Button variant="ghost" size="icon-sm" onClick={onZoomOut} aria-label="Zoom out">
            <ZoomOut />
          </Button>
        </Tooltip>
        <Tooltip content="Zoom in">
          <Button variant="ghost" size="icon-sm" onClick={onZoomIn} aria-label="Zoom in">
            <ZoomIn />
          </Button>
        </Tooltip>
        <Tooltip content="Fit the whole graph in view">
          <Button variant="ghost" size="icon-sm" onClick={onFit} aria-label="Fit to view">
            <Maximize2 />
          </Button>
        </Tooltip>
      </div>
    </div>
  )
}
