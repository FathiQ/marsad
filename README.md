<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/mark.svg">
    <img src="docs/brand/mark-onlight.svg" alt="" width="128" height="128">
  </picture>
</p>

<h1 align="center">Marsad</h1>

<p align="center">
  <strong>The observatory for your Kubernetes network policies.</strong>
</p>

<p align="center">
  <a href="https://github.com/FathiQ/marsad/actions/workflows/ci.yml"><img src="https://github.com/FathiQ/marsad/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="Apache 2.0"></a>
  <a href="https://github.com/FathiQ/marsad/pkgs/container/marsad"><img src="https://img.shields.io/badge/ghcr.io-marsad-blue.svg" alt="Container image"></a>
</p>

---

Marsad (مرصد, *"observatory"*) is a read-only web dashboard that shows what your
cluster's network security posture actually *is*, according to the policies you
have declared. It renders an interactive graph of your workloads and the ingress
and egress rules that apply to them — including AWS domain-based egress — and
lets you ask whether a given connection would be allowed, and which rule decides.

It reads declared configuration, not live traffic. Nothing is ever mutated:
every call to the Kubernetes API is `get`, `list`, or `watch`.

## Why

Reading a cluster's NetworkPolicies by hand goes wrong in predictable ways. A
`namespaceSelector` and a `podSelector` in one peer are ANDed; split across two
peers they are ORed, and the policy is far broader than intended. A policy with
only egress rules and no `policyTypes` silently denies *all* ingress. A pod that
no policy selects is wide open in both directions, and nothing in `kubectl get
netpol` tells you that.

Marsad answers those questions from the configuration itself, and for every edge
it draws, it can point at the exact rule that produced it.

## What it does

- **A graph of what your policies permit.** Namespaces as containers, workloads
  as cards, with each destination's open ports on the card that accepts them.
  Aggregates at the namespace level and drills down to workloads on demand.
- **Simulation.** Ask "would this pod reach that one, on this port?" and get the
  verdict plus the rule that produced it — on both the egress and the ingress
  side, which is the half people usually forget.
- **Unprotected workloads, called out.** A workload no policy selects is drawn
  in the danger colour, and its card says "open from anything" or "open to
  anything" rather than leaving you to infer it from absent edges.
- **AWS domain egress.** `networking.k8s.aws/v1alpha1` ApplicationNetworkPolicy,
  including `domainNames`, detected via discovery. On clusters without the CRD
  Marsad degrades cleanly and says so.
- **Live updates.** Shared informers watch the cluster and the graph is
  recomputed on change, never polled.
- **Honest uncertainty.** Some questions — does `*.s3.amazonaws.com` cover this
  IP? — need DNS resolution Marsad does not observe. Those are marked
  `Approximate` or `Undecidable` with the reason, never collapsed into a yes.

## Quick start

Marsad needs read access to a cluster and nothing else.

```sh
kubectl apply -f deploy/
kubectl -n marsad port-forward svc/marsad 8080:80
open http://localhost:8080
```

Published images are on GitHub Container Registry, for `linux/amd64` and
`linux/arm64`:

```sh
docker pull ghcr.io/fathiq/marsad:latest
```

There is no Ingress and no authentication in v1, by design: reach it with
`port-forward`, which reuses the cluster's own authn and authz instead of
inventing a second, weaker one. `make undeploy` removes everything.

To try it with policies worth looking at, `make kind-up` builds a local kind
cluster with the AWS CRD and [`examples/`](examples/) applied.

## Supported policy types

| Type | Support |
|---|---|
| `networking.k8s.io/v1` NetworkPolicy | full — ipBlock, selectors, ports, endPort, named ports, both policyTypes |
| `networking.k8s.aws/v1alpha1` ApplicationNetworkPolicy | full — including `domainNames` egress. Detected via discovery |
| Cilium / Calico policies | not in v1. `npeval.Provider` exists so they can be added without touching the evaluator |

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/meta` | cluster capabilities, object counts, anything Marsad could not read |
| `GET /api/namespaces` | per-namespace workload, policy and unprotected counts |
| `GET /api/graph?level=namespace\|workload&namespaces=a,b` | the graph |
| `GET /api/workloads/{ns}/{name}` | applied policies with YAML, effective rules, isolation |
| `POST /api/simulate` | would this connection be allowed, and which rule decides |
| `GET /api/stream` | WebSocket; a fresh graph on every cluster change |

## Architecture

- **Backend (Go, single static binary).** client-go shared informers watch
  policies and workloads; the graph is recomputed incrementally on change. The
  frontend is embedded via `embed.FS`, so deploying is one image with no sidecar
  and no static-asset bucket.
- **[`pkg/npeval`](pkg/npeval)** is the semantic core, and deliberately has no
  HTTP, no UI and no client-go dependency — it evaluates an immutable snapshot
  of objects a caller has already fetched. That is what lets the same code back
  the server, a CLI, and a CI check. See
  [docs/design/npeval.md](docs/design/npeval.md) for the semantics it implements.
- **Frontend (React + TypeScript + Vite)** on Tailwind and Radix primitives,
  with a WebGL renderer so clusters with thousands of pods stay interactive.
  Animated dots trace paths a rule *permits* — Marsad reads declared policy and
  never observes traffic, and the UI is careful to say which.

## Security

Marsad requires only `get`, `list` and `watch`; the minimal ClusterRole is in
[`deploy/rbac.yaml`](deploy/rbac.yaml). There is no write path in the codebase —
not a disabled one, an absent one. The image is distroless and runs as
non-root with no shell and no package manager.

To report a vulnerability, please open a
[security advisory](https://github.com/FathiQ/marsad/security/advisories/new)
rather than a public issue.

## Development

Everything runs in Docker — no Go, Node, or Kubernetes tooling on your machine.

```sh
make test      # Go test suite
make lint      # golangci-lint
make vuln      # govulncheck
make web-lint  # tsc + eslint
make e2e       # Playwright smoke test
make dev       # backend against your current kubeconfig on :8080
make help      # all targets
```

See [docs/development.md](docs/development.md) and
[CONTRIBUTING.md](CONTRIBUTING.md).

## Status

Running and useful. The evaluation core, the informer layer, the API and the
dashboard are built and tested.

Not yet built: a Helm chart, graph exports, and end-to-end CI against a real
kind cluster. A findings engine — named rules over the evaluated model, for the
problems the graph cannot show, such as an overly broad `*.amazonaws.com`
wildcard or a policy whose selector matches nothing — is designed but
deliberately not started.

## License

Apache 2.0. See [LICENSE](LICENSE).
