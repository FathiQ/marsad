import type { Page } from '@playwright/test'

/**
 * A small cluster that exercises every visual case the graph has: an explicitly
 * allowed edge, one allowed only by the absence of policy, an approximate one, a
 * domain peer, and a workload nothing protects.
 */
export const meta = {
  revision: 3,
  builtAt: '2026-08-05T00:00:00Z',
  capabilities: {
    policies: [
      { provider: 'k8s', group: 'networking.k8s.io', resource: 'networkpolicies', available: true },
      {
        provider: 'aws-anp',
        group: 'networking.k8s.aws',
        resource: 'applicationnetworkpolicies',
        available: false,
        reason: 'the ApplicationNetworkPolicy CRD is not installed on this cluster',
      },
    ],
  },
  counts: { namespaces: 2, workloads: 3, policies: 2 },
  warnings: null,
  combineMode: 'intersect',
  readOnly: true,
  version: 'v1.2.3-test',
}

export const namespaces = [
  { name: 'prod', workloads: 2, policies: 2, unprotected: 1 },
  { name: 'edge', workloads: 1, policies: 0, unprotected: 1 },
]

export const graph = {
  level: 'workload',
  nodes: [
    {
      id: 'wl:prod/Deployment/api',
      kind: 'workload',
      label: 'api',
      namespace: 'prod',
      workloadKind: 'Deployment',
      replicas: 3,
      isolation: { ingress: true, egress: true },
    },
    {
      id: 'wl:prod/Deployment/legacy',
      kind: 'workload',
      label: 'legacy',
      namespace: 'prod',
      workloadKind: 'Deployment',
      replicas: 1,
      isolation: { ingress: false, egress: false },
    },
    {
      id: 'wl:edge/Deployment/web',
      kind: 'workload',
      label: 'web',
      namespace: 'edge',
      workloadKind: 'Deployment',
      replicas: 2,
      isolation: { ingress: false, egress: true },
    },
    {
      // Sorts last in the picker despite leading alphabetically: kube- is
      // reserved for Kubernetes' own namespaces and is rarely what is meant.
      id: 'wl:kube-system/DaemonSet/kube-proxy',
      kind: 'workload',
      label: 'kube-proxy',
      namespace: 'kube-system',
      workloadKind: 'DaemonSet',
      replicas: 1,
      isolation: { ingress: false, egress: false },
    },
    { id: 'domain:*.s3.amazonaws.com', kind: 'domain', label: '*.s3.amazonaws.com' },
    { id: 'any:all', kind: 'any', label: 'any' },
  ],
  edges: [
    {
      id: 'wl:edge/Deployment/web|wl:prod/Deployment/api|allowed',
      source: 'wl:edge/Deployment/web',
      target: 'wl:prod/Deployment/api',
      kind: 'allowed',
      ports: ['8080/TCP'],
      via: ['networking.k8s.io/NetworkPolicy/prod/api-ingress#ingress[0]'],
    },
    {
      id: 'wl:prod/Deployment/api|domain:*.s3.amazonaws.com|approximate',
      source: 'wl:prod/Deployment/api',
      target: 'domain:*.s3.amazonaws.com',
      kind: 'approximate',
      ports: ['443/TCP'],
      via: ['networking.k8s.aws/ApplicationNetworkPolicy/prod/aws#egress[0]'],
      note: 'whether they overlap depends on DNS resolution, which Marsad does not observe',
    },
    {
      id: 'any:all|wl:prod/Deployment/legacy|default',
      source: 'any:all',
      target: 'wl:prod/Deployment/legacy',
      kind: 'default',
      // Deliberately null, not []. This is what a server that violates its own
      // contract sends, and it used to crash the whole page on click.
      via: null as unknown as string[],
      note: 'no policy isolates this workload',
    },
  ],
}

export const workloadDetail = {
  workload: {
    ref: { group: 'apps', kind: 'Deployment', namespace: 'prod', name: 'api' },
    kind: 'Deployment',
    labels: { app: 'api' },
    replicas: 3,
    ports: [{ name: 'http', port: 8080, protocol: 'TCP' }],
  },
  isolation: { ingress: true, egress: true },
  policies: [
    {
      ref: { group: 'networking.k8s.io', kind: 'NetworkPolicy', namespace: 'prod', name: 'api-ingress' },
      provider: 'k8s',
      types: 'Ingress',
      selector: 'app=api',
      yaml: 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nspec:\n  podSelector:\n    matchLabels:\n      app: api\n',
    },
  ],
  ingress: {
    workload: { kind: 'Deployment', namespace: 'prod', name: 'api' },
    direction: 0,
    isolated: true,
    allows: [
      {
        peer: { kind: 'pods', display: 'ns=edge, app=web', workloads: [] },
        ports: [{ protocol: 'TCP', from: 8080, to: 8080 }],
        via: ['networking.k8s.io/NetworkPolicy/prod/api-ingress#ingress[0]'],
      },
    ],
  },
  egress: {
    workload: { kind: 'Deployment', namespace: 'prod', name: 'api' },
    direction: 1,
    isolated: true,
    allows: [],
  },
}

/** A denied connection whose two halves disagree — the case the panel exists
 * for. The source may not leave; the destination would have accepted. */
export const verdict = {
  allowed: false,
  undecidable: false,
  egress: {
    result: 'denied',
    reason: 'no-matching-rule',
    explain:
      'apps/Deployment/edge/web is egress-isolated by networking.k8s.io/NetworkPolicy/edge/web-egress and no rule allows apps/Deployment/prod/api on 8080/TCP',
    byLayer: { k8s: 'denied', 'aws-anp': 'undecidable' },
  },
  ingress: {
    result: 'allowed',
    reason: 'matched-rule',
    via: ['networking.k8s.io/NetworkPolicy/prod/api-ingress#ingress[0]'],
    explain: 'apps/Deployment/prod/api ingress to apps/Deployment/edge/web on 8080/TCP is allowed',
  },
  summary: 'DENIED: apps/Deployment/edge/web → apps/Deployment/prod/api on 8080/TCP',
}

/** Serves the fixture cluster and lets the websocket fail, which is a state the
 * UI must survive: it falls back to the HTTP fetch and reports "offline". */
export async function mockApi(page: Page) {
  await page.route('**/api/meta', (r) => r.fulfill({ json: meta }))
  await page.route('**/api/namespaces', (r) => r.fulfill({ json: namespaces }))
  await page.route('**/api/graph*', (r) => r.fulfill({ json: { revision: 3, graph } }))
  await page.route('**/api/workloads/**', (r) => r.fulfill({ json: workloadDetail }))
  await page.route('**/api/simulate', (r) => r.fulfill({ json: verdict }))
}
