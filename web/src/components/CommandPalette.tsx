import { Boxes, Globe, Layers, Network } from 'lucide-react'
import { useMemo } from 'react'

import type { GraphNode, NamespaceSummary } from '../api'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command'
import { Badge } from './ui/badge'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  nodes: GraphNode[]
  namespaces: NamespaceSummary[]
  onSelectNode: (node: GraphNode) => void
  onSelectNamespace: (name: string) => void
}

const ICONS = {
  workload: Boxes,
  namespace: Layers,
  domain: Globe,
  cidr: Network,
  world: Globe,
  any: Network,
} as const

/**
 * On a cluster with hundreds of namespaces, typing a name is the only navigation
 * that scales. cmdk does the fuzzy matching, so "kbsys" still finds kube-system.
 */
export function CommandPalette({
  open,
  onOpenChange,
  nodes,
  namespaces,
  onSelectNode,
  onSelectNamespace,
}: Props) {
  const workloads = useMemo(() => nodes.filter((n) => n.kind !== 'namespace').slice(0, 300), [nodes])

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} label="Search the cluster">
      <CommandInput placeholder="Search workloads, namespaces and peers…" />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>

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

        <CommandGroup heading="Workloads and peers">
          {workloads.map((node) => {
            const Icon = ICONS[node.kind] ?? Boxes
            return (
              <CommandItem
                key={node.id}
                value={`${node.namespace ?? ''} ${node.label} ${node.workloadKind ?? node.kind}`}
                onSelect={() => {
                  onSelectNode(node)
                  onOpenChange(false)
                }}
              >
                <Icon />
                <span className="flex-1 truncate">{node.label}</span>
                <span className="text-[11px] text-faint">
                  {node.namespace ?? node.kind}
                </span>
              </CommandItem>
            )
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
