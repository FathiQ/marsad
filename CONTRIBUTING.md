# Contributing to Marsad

## Getting set up

You need Docker and nothing else. Every toolchain runs in a container.

```sh
make test    # run the test suite
make lint    # golangci-lint
make fmt     # gofmt the tree
make help    # all targets
```

See [docs/development.md](docs/development.md) for details, including how to
point the dev server at your own cluster.

## Ground rules

**Read-only, always.** Marsad never writes to the Kubernetes API. A pull request
that adds a create, update, patch, or delete call will not be merged, however
convenient the feature. The ClusterRole we ship is get/list/watch, and it stays
that way.

**Never guess at malformed policy.** If a policy object is invalid, `Normalize`
returns an error naming the field path. A tool that silently reinterprets a
broken rule is more dangerous than one that says it cannot read it.

**Never state a confident answer you cannot derive.** Some questions — does
`*.s3.amazonaws.com` include this IP address? — need DNS resolution, which Marsad
does not observe. Those results are marked `Approximate` or `Undecidable` and
explain why. Do not collapse them into an allow or a deny.

## Working on `pkg/npeval`

This package is the semantic core, and it is where correctness matters most: the
edge cases in NetworkPolicy's nil-versus-empty semantics are numerous and easy to
get subtly wrong in a way no one notices until it misreports a real cluster.

- Every semantic rule gets a table-driven test. The full list of behaviors we
  pin is in [docs/design/npeval.md §9](docs/design/npeval.md).
- Keep the dependency floor. The core imports stdlib and
  `k8s.io/apimachinery` only — no `k8s.io/api`, no client-go. Vendor types live
  behind `Provider` implementations, which is what keeps the package usable as a
  library and CI check rather than only as a server component.
- Output must be deterministic. The graph is diffed between snapshots, so sort
  anything you return.

## Adding a policy provider

Cilium and Calico were designed for but not built. To add one:

1. Implement `npeval.Provider` in `pkg/npeval/provider/<name>/`.
2. Declare its `Capabilities` honestly — particularly `DenyRules` and `Layer7`.
   The UI uses these to tell users what the graph is not showing.
3. Do not add deny semantics to the evaluator. Each provider is an independent
   layer (see `CombineMode`), which is precisely what keeps an ordered
   deny-capable language from corrupting the additive Kubernetes model.

## Commits and pull requests

Explain *why* in the commit message; the diff already shows what. If you are
changing evaluation semantics, say which upstream documentation or CRD schema
supports the change — that is the standard the existing code is held to, and
several comments cite the exact sentence they encode.

## What CI does with your pull request

Two workflows run, and they answer different questions.

[`ci.yml`](.github/workflows/ci.yml) decides whether the change is **correct**.
It runs on every push to the branch: `go build`, `go test -race`,
golangci-lint, govulncheck, `go mod tidy` with a dirty-tree check, and for the
frontend `tsc`, eslint with `--max-warnings 0`, a production build and the
Playwright smoke test. All of it reproduces locally through `make` — nothing in
CI needs a tool you do not already have in a container.

It also lints and renders the Helm chart, and asserts that the ClusterRole the
chart produces grants nothing but `get`, `list` and `watch`. That check is there
because the read-only promise is the product, and a chart is the easiest place
to widen it by accident. `make helm-lint` runs the same thing.

[`build.yml`](.github/workflows/build.yml) decides whether the change is worth
an **artifact**. It builds the multi-architecture image and publishes it to
`ghcr.io`, and it is gated on a maintainer approving the pull request rather
than on any push. Approving a change publishes `pr-<number>`; merging to `main`
publishes `main` and a `sha-` tag; a `v*` tag publishes the semver tags and
moves `latest`.

Two consequences worth knowing:

- **A pull request from a fork builds but never publishes.** The token in that
  event context can write packages, and an approval is a judgement about code,
  not a grant of push rights to the registry.
- **The build does not re-run the tests.** Keeping the two concerns separate
  relies on the `ci.yml` checks being required in branch protection; that
  setting, not this workflow, is what stops an approval from publishing an
  image whose tests are red.
