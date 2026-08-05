# Marsad

**Marsad — the observatory for your Kubernetes network policies.**

Marsad (مرصد, *"observatory"*) is a read-only web dashboard that shows what your
cluster's network security posture actually *is*, according to the policies you
have declared. It renders an interactive graph of your workloads, the ingress and
egress rules that apply to them — including AWS domain-based egress — and flags
what is insecure or simply broken.

It reads declared configuration, not live traffic. Nothing is ever mutated: every
call to the Kubernetes API is get, list, or watch.

<!-- TODO: demo GIF -->

## Why

Reading a cluster's NetworkPolicies by hand goes wrong in predictable ways. A
`namespaceSelector` and a `podSelector` in one peer are ANDed; split across two
peers they are ORed, and the policy is far broader than intended. A policy with
only egress rules and no `policyTypes` silently denies *all* ingress. A pod that
no policy selects is wide open in both directions, and nothing in `kubectl get
netpol` tells you that.

Marsad answers those questions from the configuration itself, and for every edge
it draws, it can point at the exact rule that produced it.

## Status

Early but running. The evaluation core, the cluster watcher and the API are built
and tested; the frontend is next. `make dev` will point the backend at your
current kubeconfig and serve the API on :8080.

See [docs/design/npeval.md](docs/design/npeval.md) for the policy semantics it
implements, and [the build order](#build-order) for what comes next.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/meta` | cluster capabilities, object counts, anything Marsad could not read |
| `GET /api/namespaces` | per-namespace workload, policy and unprotected counts |
| `GET /api/graph?level=namespace\|workload&namespaces=a,b` | the graph |
| `GET /api/workloads/{ns}/{name}` | applied policies with YAML, effective rules, isolation |
| `POST /api/simulate` | would this connection be allowed, and which rule decides |
| `GET /api/stream` | WebSocket; a fresh graph on every cluster change |

## Supported policy types

| Type | Support |
|---|---|
| `networking.k8s.io/v1` NetworkPolicy | full — ipBlock, selectors, ports, endPort, named ports, both policyTypes |
| `networking.k8s.aws/v1alpha1` ApplicationNetworkPolicy | full — including `domainNames` egress. Detected via discovery; on non-EKS clusters Marsad degrades cleanly and says so |
| Cilium / Calico policies | not in v1. `npeval.Provider` exists so they can be added without touching the evaluator |

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

For a local cluster with policies to look at:

```sh
make kind-up      # kind cluster + the AWS CRD + examples/
make kind-deploy  # build, load and deploy into it
kubectl --context kind-marsad -n marsad port-forward svc/marsad 8080:80
```

See [docs/development.md](docs/development.md).

## Deploying

```sh
# once, if you use ECR
aws ecr create-repository --repository-name marsad --region <region>
aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com

make push deploy REGISTRY=<account>.dkr.ecr.<region>.amazonaws.com/marsad
kubectl -n marsad port-forward svc/marsad 8080:80
```

Images are tagged and deployed by commit, not by a floating tag, so a running
pod is traceable to a revision. The build cross-compiles, so an arm64 laptop
produces an amd64 image for amd64 nodes in seconds rather than minutes under
emulation — set `PLATFORM` if your nodes are Graviton.

`make undeploy` removes everything. There is no Ingress and no authentication in
v1 by design: reach it with `port-forward`, which reuses the cluster's own authn
and authz rather than inventing a second, weaker one.

## Architecture

- **Backend (Go, single static binary).** client-go shared informers watch
  policies and workloads; the graph is recomputed incrementally on change, never
  polled. The frontend is embedded via `embed.FS`.
- **`pkg/npeval`** is the semantic core, and deliberately has no HTTP, no UI and
  no client-go dependency — it evaluates an immutable snapshot of objects a
  caller has already fetched. That is what lets the same code back the server, a
  CLI, and a CI check.
- **Frontend (React + TypeScript + Vite)** with a WebGL graph renderer, so
  clusters with thousands of pods stay interactive. The default view aggregates
  at the namespace level and drills down to workloads, then pods, on demand.

## Security

Marsad requires only `get`, `list` and `watch`. A minimal ClusterRole ships with
the Helm chart. There is no write path in the codebase — not a disabled one, an
absent one.

## Build order

1. ✅ `pkg/npeval` — policy evaluation core, with tests
2. ✅ Informer layer, graph model, REST + WebSocket API
3. ✅ Frontend graph: namespace level, then drill-down
4. Findings engine and its UI surfacing
5. Simulate panel, exports, Helm chart, CI polish

## License

Apache 2.0. See [LICENSE](LICENSE).
