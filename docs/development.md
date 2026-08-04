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

## Running against a cluster

```sh
make dev          # backend on http://localhost:8080, against your current context
make dev-shell    # a shell in the same container
```

`make dev` uses the `dev` compose service, built from `docker/dev.Dockerfile`.
It is separate from the `go` service that runs the tests, so the test loop never
waits on it.

### Credentials

The dev container mounts `$KUBECONFIG` (defaulting to `~/.kube/config`) and
`~/.aws`, both read-only. Marsad only ever issues get/list/watch, and the
read-only mounts make that structurally true of the dev loop as well.

EKS kubeconfigs authenticate through an exec credential plugin — `aws eks
get-token` — which runs wherever the *client* runs, so the AWS CLI is installed
in the dev image. Mounting `~/.aws` alone would not be enough.

If startup reports:

```
The API server rejected the credentials.
```

your SSO session has expired. Run `aws sso login` (with `--profile` if you use
one) **on the host**; the refreshed token lands in `~/.aws/sso/cache`, which the
container already sees.

Set `AWS_PROFILE` in your environment if the cluster needs a non-default profile;
compose passes it through.

### Other clusters

For a kind cluster, or anything else reachable only at `127.0.0.1` on the host,
the container will not see it: point `--kubeconfig` at an endpoint reachable from
inside Docker, or substitute `host.docker.internal` for `127.0.0.1`.

## Running a single test

```sh
make test ARGS='-run TestIsolation ./pkg/npeval/'
```
