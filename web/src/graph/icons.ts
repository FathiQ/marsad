/**
 * Node pictograms.
 *
 * Drawn as white-on-transparent masks and recoloured by the renderer, so one
 * icon works on any node colour and in either theme. Inlined as data URIs
 * because the binary embeds the whole frontend — a sprite sheet fetched at
 * runtime would be one more thing to get wrong behind a port-forward.
 *
 * The explicit width and height matter: a browser will not rasterise an <img>
 * SVG that carries only a viewBox, and the failure is silent — the pictogram
 * simply never appears.
 */

const svg = (body: string): string =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`,
  )}`

/** Stacked layers: a controller managing replicas. */
const deployment = svg(
  '<path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>',
)

/** A database-ish cylinder: ordered, persistent identity. */
const statefulSet = svg(
  '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
)

/** One per node: a row of servers. */
const daemonSet = svg(
  '<rect x="2" y="3" width="20" height="6" rx="1.5"/><rect x="2" y="15" width="20" height="6" rx="1.5"/><path d="M6 6h.01M6 18h.01"/>',
)

/** Runs to completion. */
const job = svg('<path d="M12 6v6l4 2"/><circle cx="12" cy="12" r="9"/>')

/** Runs to completion, on a schedule. */
const cronJob = svg(
  '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 1.5"/><path d="M5 3 3 5"/><path d="m19 3 2 2"/>',
)

/** A lone container. */
const pod = svg('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M3 12h18"/>')

/** A namespace: a bounded group. */
const namespace = svg(
  '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M8 6V4h8v2"/>',
)

/** Outside the cluster, by name. */
const domain = svg(
  '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z"/>',
)

/** Outside the cluster, by address. */
const cidr = svg(
  '<rect x="3" y="8" width="18" height="9" rx="2"/><path d="M7 12h.01M11 12h.01M15 12h.01"/>',
)

/** Everything, everywhere. Deliberately the most alarming mark. */
const world = svg(
  '<circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18"/><path d="M12 3a12 12 0 0 1 4 9a12 12 0 0 1-4 9a12 12 0 0 1-4-9a12 12 0 0 1 4-9Z"/>',
)

const anyPeer = svg('<circle cx="12" cy="12" r="9"/><path d="M9.2 9a3 3 0 1 1 3.8 4.2V15"/><path d="M12 18h.01"/>')

const byWorkloadKind: Record<string, string> = {
  Deployment: deployment,
  StatefulSet: statefulSet,
  DaemonSet: daemonSet,
  Job: job,
  CronJob: cronJob,
  Pod: pod,
}

export function iconFor(kind: string, workloadKind?: string): string {
  switch (kind) {
    case 'namespace':
      return namespace
    case 'workload':
      return byWorkloadKind[workloadKind ?? ''] ?? pod
    case 'domain':
      return domain
    case 'cidr':
      return cidr
    case 'world':
      return world
    case 'any':
      return anyPeer
    default:
      return pod
  }
}
