# Development

Everything runs in Docker. You do **not** need Go, Node, or any Kubernetes
tooling installed on your machine — only Docker.

```sh
make test     # run the Go test suite
make cover    # tests + coverage summary
make lint     # golangci-lint
make fmt      # gofmt the tree
make tidy     # go mod tidy
make sh       # drop into a shell with the Go toolchain
make help     # list all targets
```

The first run pulls `golang:1.24-bookworm` and downloads modules into a named
volume, so it takes a minute. Every run after that is fast — the module and
build caches persist in Docker volumes across invocations.

## Kubeconfig

`docker-compose.yml` mounts `$KUBECONFIG` (defaulting to `~/.kube/config`)
read-only into the Go container. Marsad only ever issues get/list/watch calls,
but the read-only mount makes that structurally true for the dev loop too.

If your kubeconfig references credential plugins on the host (`aws eks get-token`,
`gke-gcloud-auth-plugin`), those binaries are not in the container. Generate a
static-token kubeconfig, or run `kubectl proxy` on the host and point the
container at `host.docker.internal:8001`.

## Running a single test

```sh
make test ARGS='-run TestIsolation ./pkg/npeval/'
```
