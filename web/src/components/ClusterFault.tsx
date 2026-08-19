import { Check, Copy, KeyRound, Lock, PlugZap, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

import type { Fault } from '../api'
import { Button } from './ui/button'

const FRAMING: Record<Fault['kind'], { icon: typeof Lock; title: string }> = {
  forbidden: { icon: Lock, title: 'Marsad is not allowed to read this cluster' },
  unauthorized: { icon: KeyRound, title: 'The cluster rejected these credentials' },
  unreachable: { icon: PlugZap, title: 'The cluster could not be reached' },
  other: { icon: TriangleAlert, title: 'The cluster could not be read' },
}

/**
 * The screen for a cluster Marsad cannot read.
 *
 * This is the most likely first-run failure there is, and it used to happen
 * entirely off-screen: the process exited, Kubernetes restarted it, and the
 * explanation existed only in a pod log that someone had to know to go and
 * read. It deserves the best error in the product, so it gets the API server's
 * exact sentence — the resource and verb it named are the only things that make
 * a permission failure fixable — and, where that would help, the ClusterRole
 * that answers it.
 */
export function ClusterFault({ fault, clusterRole }: { fault: Fault; clusterRole?: string }) {
  const [copied, setCopied] = useState(false)
  const { icon: Icon, title } = FRAMING[fault.kind] ?? FRAMING.other

  const copy = () => {
    if (!clusterRole) return
    void navigator.clipboard?.writeText(clusterRole).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="absolute inset-0 z-30 overflow-y-auto bg-canvas px-6 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-start gap-3">
          <Icon className="mt-0.5 size-6 shrink-0 text-danger" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold tracking-tight text-fg">{title}</h2>
            {fault.host && (
              <p className="mt-1 font-mono text-[11.5px] break-all text-text-dim">{fault.host}</p>
            )}
          </div>
        </div>

        {/* Verbatim, in a block that looks like what it is: the cluster
            talking, not Marsad talking about the cluster. */}
        <section className="mt-5">
          <h3 className="text-[10.5px] font-semibold tracking-[0.07em] text-text-dim uppercase">
            What the API server said
          </h3>
          <pre className="mt-2 overflow-x-auto rounded-lg border border-danger/40 bg-danger/5 p-3 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-danger">
            {fault.message}
          </pre>
        </section>

        {fault.hint && (
          <p className="mt-4 max-w-[70ch] text-[13px] leading-relaxed text-text-body">
            {fault.hint}
          </p>
        )}

        {clusterRole && (
          <section className="mt-6">
            <div className="flex items-center gap-2">
              <h3 className="flex-1 text-[10.5px] font-semibold tracking-[0.07em] text-text-dim uppercase">
                The ClusterRole it needs
              </h3>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={copy}>
                {copied ? (
                  <Check className="size-3 text-allowed-text" />
                ) : (
                  <Copy className="size-3" />
                )}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <pre className="mt-2 max-h-[26rem] overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-[11px] leading-relaxed text-text-body">
              {clusterRole}
            </pre>
            <p className="mt-2 text-[11.5px] leading-relaxed text-text-dim">
              Bind it to the ServiceAccount Marsad runs as. Every verb in it is a read — Marsad has
              no write path in its code, and this is the other half of that guarantee.
            </p>
          </section>
        )}

        <p className="mt-6 text-[11.5px] leading-relaxed text-text-dim">
          Marsad keeps retrying. Fix the permission and this screen goes away on its own; nothing
          needs restarting.
        </p>
      </div>
    </div>
  )
}
