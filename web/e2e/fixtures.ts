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
  // Four workloads, matching the graph: api, legacy, web and kube-proxy. The
  // header's total and the rail's "N of M" read from different sources — the
  // cluster and the drawn graph — and a fixture where they disagree makes every
  // screenshot look like a bug.
  counts: { namespaces: 2, workloads: 4, policies: 2 },
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
  // Which policies caused the isolation, not just that it exists: the panel
  // says "Ingress — isolated · 1 policy selects it", and the count comes from
  // here.
  isolation: {
    ingress: true,
    egress: true,
    ingressBy: [
      { group: 'networking.k8s.io', kind: 'NetworkPolicy', namespace: 'prod', name: 'api-ingress' },
    ],
    egressBy: [
      { group: 'networking.k8s.aws', kind: 'ApplicationNetworkPolicy', namespace: 'prod', name: 'aws-egress' },
    ],
  },
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
    allows: [
      {
        peer: { kind: 'domain', domain: '*.s3.us-east-1.amazonaws.com', display: '*.s3.us-east-1.amazonaws.com' },
        ports: [{ protocol: 'TCP', from: 443, to: 443 }],
        via: ['networking.k8s.aws/ApplicationNetworkPolicy/prod/aws#egress[0]'],
        approximate: true,
        note: 'Marsad does not resolve DNS, so it cannot confirm an address is covered by this wildcard.',
      },
    ],
  },
  // Rule identifiers resolved to the policy responsible, so the UI never has to
  // take an identifier apart to label a rule.
  rules: {
    'networking.k8s.io/NetworkPolicy/prod/api-ingress#ingress[0]': {
      policy: { group: 'networking.k8s.io', kind: 'NetworkPolicy', namespace: 'prod', name: 'api-ingress' },
      provider: 'k8s',
      path: 'spec.ingress[0]',
    },
    'networking.k8s.aws/ApplicationNetworkPolicy/prod/aws#egress[0]': {
      policy: { group: 'networking.k8s.aws', kind: 'ApplicationNetworkPolicy', namespace: 'prod', name: 'aws-egress' },
      provider: 'aws-anp',
      path: 'spec.egress[0]',
    },
  },
}

/**
 * The workload nothing selects.
 *
 * Both directions come back `isolated: false` with no allows and no applied
 * policies, which is what the server sends for a pod no podSelector matches.
 * It is the shape behind Marsad's headline number, so the panel has to say what
 * it means rather than leaving a blank where the rules would be.
 */
export const unprotectedDetail = {
  workload: {
    ref: { group: 'apps', kind: 'Deployment', namespace: 'prod', name: 'legacy' },
    kind: 'Deployment',
    labels: { app: 'legacy' },
    replicas: 1,
    ports: [{ name: 'http', port: 8080, protocol: 'TCP' }],
  },
  isolation: { ingress: false, egress: false },
  policies: [],
  ingress: {
    workload: { kind: 'Deployment', namespace: 'prod', name: 'legacy' },
    direction: 0,
    isolated: false,
    allows: [],
  },
  egress: {
    workload: { kind: 'Deployment', namespace: 'prod', name: 'legacy' },
    direction: 1,
    isolated: false,
    allows: [],
  },
  // The policies that nearly matched, nearest first — the answer to the
  // question "nothing selects this" provokes and used to leave hanging.
  closestMisses: [
    {
      policy: { group: 'networking.k8s.io', kind: 'NetworkPolicy', namespace: 'prod', name: 'default-deny' },
      provider: 'k8s',
      types: 'Ingress,Egress',
      selector: 'app in (api,db)',
      matched: 0,
      missed: [{ text: 'app in (api, db)', key: 'app', value: 'legacy', present: true }],
    },
    {
      policy: { group: 'networking.k8s.io', kind: 'NetworkPolicy', namespace: 'prod', name: 'allow-api-to-db' },
      provider: 'k8s',
      types: 'Ingress',
      selector: 'app=api,tier=core',
      matched: 0,
      missed: [
        { text: 'app=api', key: 'app', value: 'legacy', present: true },
        { text: 'tier=core', key: 'tier', present: false },
      ],
    },
  ],
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

/**
 * The rules behind the fixture's edges: the excerpt, not the document.
 *
 * One of them admits 0.0.0.0/0, which is what the derived caution line exists
 * for — the sentence comes from the rule, so a policy that reaches everything
 * says so however it happened to be written.
 */
export const ruleDetails = [
  {
    id: 'networking.k8s.io/NetworkPolicy/prod/api-ingress#ingress[0]',
    policy: { group: 'networking.k8s.io', kind: 'NetworkPolicy', namespace: 'prod', name: 'api-ingress' },
    provider: 'k8s',
    path: 'spec.ingress[0]',
    yaml: 'from:\n  - podSelector:\n      matchLabels:\n        app: web\nports:\n  - port: 8080\n',
  },
]

export const worldRuleDetails = [
  {
    id: 'networking.k8s.io/NetworkPolicy/prod/open-ingress#ingress[0]',
    policy: { group: 'networking.k8s.io', kind: 'NetworkPolicy', namespace: 'prod', name: 'open-ingress' },
    provider: 'k8s',
    path: 'spec.ingress[0]',
    yaml: 'from:\n  - ipBlock:\n      cidr: 0.0.0.0/0\nports:\n  - port: 5432\n',
    cautions: ['0.0.0.0/0 accepts from every address, in the cluster and outside it.'],
  },
]

/** Allowed, but leaning on a rule whose reach depends on DNS — the fourth state
 * on the verdict scale, and the one that had no path to the screen. */
export const approximateVerdict = {
  allowed: true,
  undecidable: false,
  approximate: true,
  egress: {
    result: 'allowed',
    reason: 'matched-rule',
    approximate: true,
    via: ['networking.k8s.aws/ApplicationNetworkPolicy/prod/aws#egress[0]'],
    explain:
      'apps/Deployment/prod/api egress to bucket.s3.us-east-1.amazonaws.com on 443/TCP allowed by networking.k8s.aws/ApplicationNetworkPolicy/prod/aws#egress[0]; that rule names a domain, and which addresses it covers depends on DNS resolution, which Marsad does not observe',
  },
  ingress: {
    result: 'not-applicable',
    reason: '',
    explain: 'bucket.s3.us-east-1.amazonaws.com is not a workload, so no ingress policy applies to it',
  },
  summary: 'ALLOWED: apps/Deployment/prod/api → bucket.s3.us-east-1.amazonaws.com on 443/TCP',
}

/** Neither half can be settled from configuration: a domain rule on one side,
 * an address on the other. It is in the model and had no UI path. */
export const undecidableVerdict = {
  allowed: false,
  undecidable: true,
  egress: {
    result: 'undecidable',
    reason: 'domain-resolution',
    explain:
      'policy allows the domain *.s3.us-east-1.amazonaws.com on 443/TCP; whether 52.216.0.1/32 is one of its addresses depends on DNS resolution, which Marsad does not observe',
    byLayer: { 'aws-anp': 'undecidable' },
  },
  ingress: {
    result: 'not-applicable',
    reason: '',
    explain: '52.216.0.1/32 is not a workload, so no ingress policy applies to it',
  },
  summary: 'UNDECIDABLE: apps/Deployment/prod/api → 52.216.0.1/32 on 443/TCP',
}

/** Serves the fixture cluster and lets the websocket fail, which is a state the
 * UI must survive: it falls back to the HTTP fetch and reports "offline". */
export async function mockApi(page: Page) {
  await page.route('**/api/meta', (r) => r.fulfill({ json: meta }))
  await page.route('**/api/namespaces', (r) => r.fulfill({ json: namespaces }))
  await page.route('**/api/graph*', (r) => r.fulfill({ json: { revision: 3, graph } }))
  // Routed by name rather than served flat, so the protected and unprotected
  // cases are both reachable — they are different screens, not different data.
  await page.route('**/api/workloads/**', (r) =>
    r.fulfill({ json: r.request().url().includes('/legacy') ? unprotectedDetail : workloadDetail }),
  )
  await page.route('**/api/simulate', (r) => r.fulfill({ json: verdict }))
  await page.route('**/api/rules*', (r) => r.fulfill({ json: ruleDetails }))
  await page.route('**/api/health', (r) =>
    r.fulfill({ json: { ok: true, ready: true, time: new Date().toISOString(), progress: [] } }),
  )
}
