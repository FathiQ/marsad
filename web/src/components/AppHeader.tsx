import { Moon, Route, Search, Sun, Wifi, WifiOff } from 'lucide-react'

import type { Capability, Meta } from '../api'
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
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  onOpenSearch: () => void
  onOpenSimulate: () => void
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: 'danger' }) {
  return (
    <div className="flex items-baseline gap-1.5 px-3 py-1">
      <span
        className={`num text-[13px] font-semibold ${tone === 'danger' ? 'text-danger' : 'text-fg'}`}
      >
        {value}
      </span>
      <span className={`text-[11.5px] ${tone === 'danger' ? 'text-danger' : 'text-faint'}`}>
        {label}
      </span>
    </div>
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

      <span className="hidden text-[11.5px] text-faint lg:block">
        the observatory for your Kubernetes network policies
      </span>

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
        <div className="hidden items-center divide-x divide-line overflow-hidden rounded-lg border border-line bg-bg md:flex">
          <Stat value={meta.counts.namespaces} label="namespaces" />
          <Stat value={meta.counts.workloads} label="workloads" />
          <Stat value={meta.counts.policies} label="policies" />
          {unprotected > 0 && (
            <Tooltip content="Workloads no policy selects at all — reachable from anywhere, and able to reach anywhere.">
              <div className="bg-danger/10">
                <Stat value={unprotected} label="unprotected" tone="danger" />
              </div>
            </Tooltip>
          )}
        </div>
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
