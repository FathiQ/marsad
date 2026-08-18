import { Moon, Route, Search, ShieldCheck, Sun, Wifi, WifiOff } from 'lucide-react'

import type { Capability, Meta } from '../api'
import { cn } from '../lib/cn'
import { Mark } from './Mark'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Kbd } from './ui/kbd'
import { Separator } from './ui/separator'
import { Tooltip } from './ui/tooltip'

interface Props {
  meta: Meta | null
  connected: boolean
  unprotected: number
  onlyUnprotected: boolean
  onToggleUnprotected: () => void
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  onOpenSearch: () => void
  onOpenSimulate: () => void
}

/**
 * The one number the header is for.
 *
 * Four equal counts — namespaces, workloads, policies, unprotected — gave the
 * finding the same weight as the inventory, and a viewer scanning the bar had
 * to read all four to learn whether anything was wrong. Only one of them is a
 * question; the rest are context, and they read as context now.
 *
 * It is also a control. Being told 3 workloads are unprotected and then having
 * to go find them in the rail is a gap the header can simply close.
 */
function PostureChip({
  unprotected,
  workloads,
  active,
  onToggle,
}: {
  unprotected: number
  workloads: number
  active: boolean
  onToggle: () => void
}) {
  const clear = unprotected === 0
  return (
    <Tooltip
      content={
        clear
          ? 'Every workload is selected by at least one policy. That is not the same as being well protected, but nothing is wide open by default.'
          : active
            ? 'Showing only these. Click to show everything again.'
            : 'Workloads no policy selects at all — reachable from anywhere, and able to reach anywhere. Click to show only these.'
      }
    >
      <button
        onClick={onToggle}
        aria-pressed={active}
        disabled={clear}
        className={cn(
          'flex items-baseline gap-1.5 rounded-lg border px-2.5 py-1 transition-colors',
          'outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
          clear
            ? 'cursor-default border-line bg-surface'
            : active
              ? 'border-danger bg-danger/20'
              : 'border-danger/40 bg-danger/10 hover:bg-danger/20',
        )}
      >
        {clear ? (
          <>
            <ShieldCheck className="size-3.5 self-center text-allowed" />
            <span className="text-[12px] text-muted">nothing unprotected</span>
          </>
        ) : (
          <>
            <span className="num text-[13px] font-semibold text-danger">{unprotected}</span>
            <span className="text-[12px] text-danger">
              unprotected of <span className="num">{workloads}</span> workloads
            </span>
          </>
        )}
      </button>
    </Tooltip>
  )
}

function CapabilityPill({ capability }: { capability: Capability }) {
  // A graph that quietly omits domain policies is worse than one that admits it
  // cannot see them, so an unavailable provider is stated in the header.
  return (
    <Tooltip content={capability.reason}>
      <Badge tone="neutral" className="border-dashed">
        <span className="size-1.5 rounded-full bg-faint" />
        {capability.provider === 'aws-anp' ? 'domain policies off' : `${capability.provider} off`}
      </Badge>
    </Tooltip>
  )
}

export function AppHeader({
  meta,
  connected,
  unprotected,
  onlyUnprotected,
  onToggleUnprotected,
  theme,
  onToggleTheme,
  onOpenSearch,
  onOpenSimulate,
}: Props) {
  const unavailable = meta?.capabilities.policies.filter((p) => !p.available) ?? []

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
      <div className="flex items-center gap-2.5">
        <Mark className="size-[19px] text-fg" />
        <span className="text-[15px] font-semibold tracking-tight">Marsad</span>
        {/* The build, from the server rather than the bundle: after an upgrade
            the question is which binary is answering, and a number baked into
            the page a browser may have cached cannot say. */}
        {meta?.version && (
          <span className="num text-[10.5px] text-faint" title="the running build">
            {meta.version}
          </span>
        )}
      </div>

      <Separator orientation="vertical" className="h-5" />

      {/* The inventory, demoted. It is what the cluster contains, not what is
          wrong with it, and the tagline that used to sit here belongs on the
          splash — by the time this bar is on screen, nobody needs telling what
          they opened. */}
      {meta && (
        <span className="hidden text-[11.5px] text-text-dim md:block">
          <span className="num">{meta.counts.namespaces}</span> namespaces
          <span className="px-1.5 opacity-50">·</span>
          <span className="num">{meta.counts.policies}</span> policies
        </span>
      )}

      <div className="flex-1" />

      <Button
        variant="outline"
        size="md"
        onClick={onOpenSearch}
        className="gap-2 pr-1.5 pl-2.5 text-muted"
      >
        <Search className="size-3.5" />
        <span className="hidden text-[12.5px] sm:inline">Search</span>
        <Kbd className="ml-1">/</Kbd>
      </Button>

      <Button variant="outline" size="md" onClick={onOpenSimulate}>
        <Route />
        <span className="hidden text-[12.5px] sm:inline">Simulate</span>
        <Kbd className="ml-1">s</Kbd>
      </Button>

      {meta && (
        <PostureChip
          unprotected={unprotected}
          workloads={meta.counts.workloads}
          active={onlyUnprotected}
          onToggle={onToggleUnprotected}
        />
      )}

      {unavailable.map((c) => (
        <CapabilityPill key={c.provider} capability={c} />
      ))}

      <Tooltip
        content={
          connected
            ? 'Streaming live: the graph updates as the cluster changes.'
            : 'The update stream is down. The graph shown is the last one received.'
        }
      >
        <Badge tone={connected ? 'ok' : 'neutral'}>
          {connected ? (
            <>
              <Wifi className="size-3" />
              live
            </>
          ) : (
            <>
              <WifiOff className="size-3" />
              offline
            </>
          )}
        </Badge>
      </Tooltip>

      <Button variant="outline" size="icon" onClick={onToggleTheme} aria-label="Toggle theme">
        {theme === 'dark' ? <Moon /> : <Sun />}
      </Button>
    </header>
  )
}
