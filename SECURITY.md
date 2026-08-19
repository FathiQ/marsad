# Security policy

## Reporting a vulnerability

Report privately, through GitHub's private security advisories:

**https://github.com/FathiQ/marsad/security/advisories/new**

Please do not open a public issue, a pull request, or a discussion for something
you believe is exploitable. The advisory form is private to you and the
maintainers until a fix is published, which is what lets a fix and its
disclosure land together.

What helps most, in rough order:

- the version — the header shows it, and `GET /api/meta` returns it
- how Marsad is deployed: Helm chart, `deploy/` manifests, or `make dev` against
  a kubeconfig
- what an attacker would need to already have — network reach to the port, a
  kubeconfig, the ability to create objects in the cluster Marsad is reading
- the smallest reproduction you have, ideally a manifest plus a request

This is a small project with one maintainer. Reports are handled on a best
effort basis: expect an acknowledgement within a few days, and an assessment
once there is one to give. Those are intentions rather than commitments, and
saying so here is more useful than inventing a number nobody is on call to meet.
If a report is accepted, the fix ships as a new patch release and the advisory
is published with it; credit goes to the reporter unless they ask otherwise.

## Supported versions

The most recent release only. Fixes land on `main` and ship as a new patch tag —
there are no maintenance branches for older minors, and backporting to one would
be a promise this project cannot keep.

## What Marsad does, and what that bounds

Marsad reads declared configuration and renders it. That shapes what a
vulnerability in it can be.

**It never writes to a cluster.** There is no create, update, patch, or delete
call in the codebase — not a disabled one, an absent one. The ClusterRole it
ships with grants `get`, `list` and `watch` and nothing else
([`deploy/rbac.yaml`](deploy/rbac.yaml),
[`charts/marsad/templates/rbac.yaml`](charts/marsad/templates/rbac.yaml)), and
CI fails the build if the rendered ClusterRole contains any other verb. The read
only promise is the product, so it is checked rather than asserted.

**It reads cluster configuration, including your NetworkPolicies.** Namespaces,
pods, services, Deployments, StatefulSets, DaemonSets, Jobs, CronJobs,
ReplicaSets, `networking.k8s.io/v1` NetworkPolicies and, where the CRD exists,
`networking.k8s.aws/v1alpha1` ApplicationNetworkPolicies. Object names, labels,
selectors and whole policy documents are returned by the API and shown in the
UI. Treat the port as carrying everything in that list.

**It observes no traffic.** No packet capture, no eBPF, no flow logs. Nothing
Marsad reports comes from data in flight, so it holds no traffic contents to
leak.

**Nothing is persisted.** State is an in-memory snapshot rebuilt from informers.
There is no database, no cache on disk, and no writable path in the image.

## Deployment assumptions

Marsad ships with no authentication and no Ingress, deliberately. It is reached
with `kubectl port-forward`, which reuses the cluster's own authentication and
authorization instead of inventing a second, weaker one. The consequence is
explicit: **anyone who can reach the HTTP port can read everything Marsad can
read.** Exposing the Service through an Ingress, a LoadBalancer, or a shared
port-forward publishes your cluster's policy configuration to whoever can reach
it. That is a deployment decision, not a defect in Marsad, and reports that
consist only of "the dashboard is unauthenticated" will be closed as documented
behaviour.

The image is distroless and runs as non-root, with no shell and no package
manager. The chart sets `readOnlyRootFilesystem`, drops all capabilities and
disallows privilege escalation.

## In scope

- Any path that lets Marsad mutate a cluster, or that widens the permissions it
  requests
- Remote code execution, SSRF, or path traversal in the Go server
- Reading cluster data through the API that the process should not have been
  able to read at all — for example escaping the informer snapshot to make a
  direct API call on the caller's behalf
- Injection through cluster-controlled strings: an object name, label, or policy
  field that reaches the dashboard and executes, or that corrupts the API's
  responses
- A dependency vulnerability with a demonstrated path through Marsad's own code.
  `govulncheck` runs in CI precisely because reachability is the part that
  matters
- Container or supply chain issues in the published image or the Helm chart

## Out of scope

- The absence of authentication, TLS, and an Ingress — see above
- Anything requiring privileges that already defeat the model: a kubeconfig with
  write access, `exec` into the pod, or cluster-admin
- Denial of service by a caller who already has access to the port, or by
  loading a cluster with pathological numbers of objects
- Scanner output with no demonstrated path through Marsad — a CVE in a
  transitive module that no code reaches is a report we will read, and probably
  not a vulnerability
- Missing security headers on a dashboard reached over a local port-forward,
  absent a concrete attack
- Social engineering, and findings against a fork or a modified build

## A note on the answers Marsad gives

Marsad evaluates declared policy. It does not prove what a cluster's data plane
does, and a CNI may enforce more or less than the objects say. Some questions —
does `*.s3.amazonaws.com` cover this IP address? — need DNS resolution Marsad
never performs, and those answers are marked `Approximate` or `Undecidable` with
the reason.

A *wrong* verdict is a correctness bug, and a serious one: report it as an
issue. It becomes a security report when the evaluator can be made to say
"allowed" for a connection the declared policy denies, or "not isolated" for a
workload that is — because at that point the tool is producing false assurance,
and somebody will act on it.
