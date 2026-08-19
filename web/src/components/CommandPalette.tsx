import { Boxes, FileCode2, Globe, Layers, Network, Route } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { fetchPolicies, type GraphNode, type NamespaceSummary, type PolicySummary } from '../api'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command'
import { Badge } from './ui/badge'
import { Kbd } from './ui/kbd'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  nodes: GraphNode[]
  namespaces: NamespaceSummary[]
  onSelectNode: (node: GraphNode) => void
  onSelectNamespace: (name: string) => void
  onSimulate: () => void
  /** Open the simulate panel already framed by this workload. */
  onSimulateFrom: (node: GraphNode) => void
}

const ICONS = {
  workload: Boxes,
  namespace: Layers,
  domain: Globe,
  cidr: Network,
  world: Globe,
  any: Network,
} as const

/** A workload no policy selects at all. */
function isUnprotected(node: GraphNode): boolean {
  return node.kind === 'workload' && node.isolation
    ? !node.isolation.ingress && !node.isolation.egress
    : false
}

/**
 * One way in.
 *
 * On a cluster with hundreds of namespaces, typing a name is the only
 * navigation that scales — and search and simulate used to be two buttons
 * beside each other doing the same thing to different halves of the question.
 * cmdk does the fuzzy matching, so "kbsys" still finds kube-system.
 *
 * The palette launches the tool's actual verb, not just navigation: ⌘↵ on any
 * workload opens the simulation already framed by it. Being able to find a
 * thing and then having to go and find it again somewhere else is the gap this
 * closes.
 */
export function CommandPalette({
  open,
  onOpenChange,
  nodes,
  namespaces,
  onSelectNode,
  onSelectNamespace,
  onSimulate,
  onSimulateFrom,
}: Props) {
  const [policies, setPolicies] = useState<PolicySummary[]>([])

  // Fetched on first open rather than held by the app: a palette nobody opens
  // costs nothing, and policies do not change often enough to re-fetch per
  // keystroke.
  useEffect(() => {
    if (!open || policies.length) return
    let cancelled = false
    fetchPolicies()
      .then((p) => !cancelled && setPolicies(p))
      .catch(() => {
        // Only the policy group is lost; everything else still searches.
      })
    return () => {
      cancelled = true
    }
  }, [open, policies.length])

  // Peers get their own heading rather than sitting under "Workloads", which
  // they are not: a domain and the any-node are things a rule points at, and
  // filing them with pods makes the posture badge beside each workload look
  // like something the domain rows are missing.
  const workloads = useMemo(
    () => nodes.filter((n) => n.kind === 'workload').slice(0, 300),
    [nodes],
  )
  const peers = useMemo(
    () => nodes.filter((n) => n.kind !== 'workload' && n.kind !== 'namespace').slice(0, 100),
    [nodes],
  )

  /**
   * ⌘↵ simulates from whatever is highlighted.
   *
   * cmdk owns the selection, and it marks the active row in the DOM rather than
   * exposing it — so the value of the highlighted item is read from there. That
   * is the same element the ↵ handler acts on, so the two keys can never
   * disagree about which row they mean.
   */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return
      const active = document.querySelector('[cmdk-item][data-selected="true"]')
      const id = active?.getAttribute('data-node-id')
      if (!id) return
      const node = nodes.find((n) => n.id === id)
      if (!node) return
      e.preventDefault()
      e.stopPropagation()
      onOpenChange(false)
      onSimulateFrom(node)
    }
    // Capture, so it runs before cmdk's own Enter handling opens the row.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, nodes, onOpenChange, onSimulateFrom])

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} label="Search the cluster">
      <CommandInput placeholder="Search workloads, namespaces, policies and peers…" />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>

        <CommandGroup heading="Workloads">
          {workloads.map((node) => {
            const Icon = ICONS[node.kind] ?? Boxes
            const unprotected = isUnprotected(node)
            return (
              <CommandItem
                key={node.id}
                data-node-id={node.id}
                value={`${node.namespace ?? ''} ${node.label} ${node.workloadKind ?? node.kind}`}
                onSelect={() => {
                  onSelectNode(node)
                  onOpenChange(false)
                }}
              >
                <Icon />
                <span className="flex-1 truncate">{node.label}</span>
                <Badge tone={unprotected ? 'danger' : 'neutral'}>
                  {unprotected ? 'unprotected' : 'protected'}
                </Badge>
                <span className="text-[11px] text-text-dim">{node.namespace}</span>
              </CommandItem>
            )
          })}
        </CommandGroup>

        <CommandGroup heading="Peers">
          {peers.map((node) => {
            const Icon = ICONS[node.kind] ?? Network
            return (
              <CommandItem
                key={node.id}
                data-node-id={node.id}
                value={`peer ${node.label} ${node.kind}`}
                onSelect={() => {
                  onSelectNode(node)
                  onOpenChange(false)
                }}
              >
                <Icon />
                <span className="flex-1 truncate font-mono text-[12.5px]">{node.label}</span>
                <span className="text-[11px] text-text-dim">{node.kind}</span>
              </CommandItem>
            )
          })}
        </CommandGroup>

        <CommandGroup heading="Namespaces">
          {namespaces.map((ns) => (
            <CommandItem
              key={`ns:${ns.name}`}
              value={`namespace ${ns.name}`}
              onSelect={() => {
                onSelectNamespace(ns.name)
                onOpenChange(false)
              }}
            >
              <Layers />
              <span className="flex-1 truncate">{ns.name}</span>
              {ns.unprotected > 0 && <Badge tone="danger">{ns.unprotected} unprotected</Badge>}
            </CommandItem>
          ))}
        </CommandGroup>

        {/* The direction a policy name actually arrives in: somebody says
            "default-deny" and you want to know what it is and what it touches.
            Until now you could only go the other way. */}
        <CommandGroup heading="Policies">
          {policies.map((p) => (
            <CommandItem
              key={`${p.ref.namespace}/${p.ref.name}/${p.provider}`}
              value={`policy ${p.ref.namespace} ${p.ref.name} ${p.selector}`}
              onSelect={() => {
                onSelectNamespace(p.ref.namespace ?? '')
                onOpenChange(false)
              }}
            >
              <FileCode2 />
              <span className="flex-1 truncate font-mono text-[12.5px]">{p.ref.name}</span>
              {/* A policy that selects nothing looks like coverage in any list
                  that does not count. */}
              {p.selects === 0 ? (
                <Badge tone="warn">selects nothing</Badge>
              ) : (
                <span className="text-[11px] text-text-dim">
                  <span className="num">{p.selects}</span> selected
                </span>
              )}
              <span className="text-[11px] text-text-dim">{p.ref.namespace}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandGroup heading="Actions">
          <CommandItem
            value="simulate connection reachability can a reach b"
            onSelect={() => {
              onOpenChange(false)
              onSimulate()
            }}
          >
            <Route />
            <span className="flex-1 truncate">Simulate a connection</span>
            <span className="text-[11px] text-text-dim">would this be allowed?</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-panel px-3 py-2 text-[11px] text-text-dim">
        <span className="flex items-center gap-1">
          <Kbd>↑↓</Kbd> navigate
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> open
        </span>
        <span className="flex items-center gap-1">
          <Kbd>⌘↵</Kbd> simulate from
        </span>
        <span className="flex items-center gap-1">
          <Kbd>esc</Kbd> close
        </span>
      </footer>
    </CommandDialog>
  )
}
