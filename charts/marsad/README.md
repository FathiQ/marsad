# Marsad Helm chart

The observatory for your Kubernetes network policies. See the
[project README](https://github.com/FathiQ/marsad) for what Marsad does.

## Install

```sh
helm install marsad oci://ghcr.io/fathiq/charts/marsad \
  --namespace marsad --create-namespace

kubectl -n marsad port-forward svc/marsad 8080:80
open http://localhost:8080
```

The chart is published as an OCI artifact, so there is no `helm repo add` step.
Helm 3.8 or newer.

To install from a checkout instead:

```sh
helm install marsad ./charts/marsad --namespace marsad --create-namespace
```

## What it grants

A ClusterRole with `get`, `list` and `watch` on namespaces, pods, services, the
`apps` and `batch` controllers, `networkpolicies`, and — where the CRD exists —
`applicationnetworkpolicies`.

Those verbs are **not configurable**. Marsad has no write path in its code, and
the ClusterRole is the second half of that guarantee: even a compromised Marsad
cannot change anything through the API. A values key that could widen them would
make the promise untrue. `rbac.create: false` exists for people who provision
RBAC out of band, and turns the whole thing off rather than editing it.

It is cluster-scoped because network policy is only meaningful across
namespaces: a peer in one namespace is selected by a policy in another, and a
`namespaceSelector` matches labels on Namespace objects themselves.

## There is no ingress block

Deliberately. Marsad has no authentication in v1, so an Ingress would publish an
unauthenticated read of your cluster's entire security posture. `port-forward`
reuses the cluster's own authn and authz instead of inventing a second, weaker
one. If you need shared access, put Marsad behind your own authenticating proxy
as a decision you have made, rather than one you inherited from a default.

Setting `service.type: LoadBalancer` has the same problem, and the chart says so
on install.

## Values

| Key | Default | Description |
|---|---|---|
| `image.repository` | `ghcr.io/fathiq/marsad` | Image repository |
| `image.tag` | `""` | Defaults to the chart's `appVersion` |
| `image.pullPolicy` | `IfNotPresent` | |
| `imagePullSecrets` | `[]` | |
| `replicaCount` | `1` | See below — more is usually worse |
| `nameOverride` / `fullnameOverride` | `""` | |
| `serviceAccount.create` | `true` | |
| `serviceAccount.name` | `""` | Defaults to the fullname |
| `serviceAccount.annotations` | `{}` | For IRSA and similar |
| `rbac.create` | `true` | Marsad reads nothing without it |
| `service.type` | `ClusterIP` | |
| `service.port` | `80` | |
| `config.logLevel` | `info` | `debug`, `info`, `warn`, `error` |
| `config.combineMode` | `intersect` | How policy layers combine — see below |
| `extraArgs` | `[]` | Appended to the container args |
| `resources` | 100m / 128Mi, limit 512Mi | |
| `podSecurityContext` | non-root, uid 65532, RuntimeDefault | |
| `securityContext` | no privilege escalation, read-only rootfs, all caps dropped | |
| `podAnnotations` / `podLabels` | `{}` | |
| `nodeSelector` / `tolerations` / `affinity` | `{}` / `[]` / `{}` | |
| `topologySpreadConstraints` | `[]` | |
| `priorityClassName` | `""` | |

### `replicaCount`

One is the right answer, not a placeholder. Each pod holds the whole cluster's
policy graph in memory and rebuilds it from its own informers, so a second
replica doubles the API watch load and the memory to serve identical, read-only
data. Raise the memory limit instead — that is the resource a large cluster
actually exhausts.

### `config.combineMode`

`intersect` shows a connection as allowed only if both the NetworkPolicy and
ApplicationNetworkPolicy layers permit it. That is the conservative reading and
matches the AWS CRD's own field documentation. `union` shows what either layer
alone would allow, which is useful when you are trying to work out which layer
is responsible for a block.

## Uninstall

```sh
helm uninstall marsad --namespace marsad
```

The ClusterRole and ClusterRoleBinding are cluster-scoped but owned by the
release, so Helm removes them too. The namespace survives if you created it with
`--create-namespace`.
