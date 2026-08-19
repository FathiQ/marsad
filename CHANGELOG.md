# Changelog

All notable changes to Marsad are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Until 1.0 the public surface — the HTTP API, `pkg/npeval`, and the chart's
values — may change on a minor bump; patch releases do not change it.

Per-release notes, in the form they were published on GitHub, are in
[docs/releases/](docs/releases/).

## [Unreleased]

Everything since 0.1.3 has been about a dashboard that says what it knows, and
what it does not.

### Added

- **A screen for a cluster Marsad cannot read.** An RBAC failure used to happen
  entirely off-screen: preflight failed, the process exited, Kubernetes
  restarted it, and the explanation lived in a pod log somebody had to know to
  go and look for. The UI now comes up either way and shows the API server's
  own error verbatim, alongside the ClusterRole that answers it — generated from
  the same rule list `deploy/rbac.yaml` is asserted against, so the YAML you are
  handed is the YAML that works.
- **Freshness as a state, not a boolean.** A graph built four minutes ago looks
  exactly like one built a second ago. The header now says whether the stream is
  live, reconnecting, or serving a snapshot, with the time of the last update or
  a countdown to the next attempt, and the canvas carries a banner whenever it
  is not live. Retrying can be stopped deliberately, and resumed.
- **Startup progress.** Waiting for informer caches is the slowest thing Marsad
  does on a large cluster. `/api/health` reports how far each group of informers
  has got, and the loading screen reads it — it is the one endpoint that answers
  while everything else is still 503.
- **Closest misses.** "No policy selects this workload" states a fact and stops.
  The inspector now ranks the policies in that namespace that nearly did, and
  shows both halves of the answer: what the policy wanted, and what the workload
  actually has. An absent label reads differently from an empty one, because one
  is a typo in the policy and the other a typo in the workload.
- **The rule beside the edge.** Clicking an edge opens an anchored popover at
  the click point containing the matching rule, not the hundred-line document it
  lives in. `GET /api/rules` resolves rule identifiers to their policy and an
  excerpt.
- **Zoom controls and a permanent legend bar**, replacing a legend that was a
  popover behind a button — the key to a picture made entirely of colour should
  not need a click, repeated every time anyone comes back to check.
- **The running version** is reported by `/api/meta` and shown beside the mark.
  The `-ldflags` value had been threaded through the Makefile, the Dockerfile and
  CI, and dropped on the floor because `main` never declared the variable.
- **An `Approximate` decision state** in `pkg/npeval`, for a verdict that is
  decided but by a rule whose reach configuration alone cannot pin down.
  `Undecidable` finally has a path to the screen.
- **An unprotected workload in `examples/`**, in a namespace that looks covered.
  `examples_test.go` asserts it stays unprotected, so a policy added later
  cannot quietly cover it and leave the demo unable to show Marsad's headline
  finding.
- **Contrast is a test.** `internal/theme` holds text to 4.5:1, structural
  colours to 3:1, and signal pairs to a minimum distance in OKLab.

### Changed

- The header leads with the finding: one chip, in danger colour, reading "N
  unprotected of M workloads", and a control rather than a statement. The other
  counts are faint context.
- The rail leads with namespaces, ordered worst-first, with filters collapsed
  into one row and an edge count on each connection toggle.
- Simulate shows its egress and ingress halves side by side rather than stacked,
  because "both must permit" is the shape of the answer. The refusing half says
  what it *does* accept.
- `--node-world` is orange and `--node-cidr` cyan, so "outside the cluster" and
  "unprotected" are no longer the same red. Graph colours are read from the
  token table rather than a hand-converted copy of it.
- The UI renders in Inter, vendored as a latin subset and served from the pod —
  `'Inter var'` had been named in the font stack for months with no `@font-face`
  to load it. Marsad reads clusters whose egress to a font CDN is blocked,
  sometimes by the policies it is drawing.
- Light theme follows `prefers-color-scheme` until a choice is actually made,
  and stores the choice only then.
- Go 1.25.13 is now the floor in `go.mod`, closing five standard library
  vulnerabilities `govulncheck` found — none in Marsad's code, all reached
  through the calls any Kubernetes client makes. CI asks setup-go for the latest
  patch rather than whatever the runner had baked in.

### Fixed

- The frontend sent no cache headers, so a browser could go on serving the index
  it already had — indistinguishable from an upgrade that never happened. The
  index is `no-cache`; fingerprinted assets are `immutable`.
- Unticking "allowed by default", a decluttering filter, also erased the
  unprotected rows from a card. They come from the workload's own isolation now.
- The Playwright edge probe found namespace containers instead of edges, because
  a namespace hue and an allowed edge are the same green.

## [0.1.3] - 2026-08-09

### Added

- Selecting a card draws its exposure as dashed edges to "anything", so openness
  is something you see rather than only read. Dashed because no rule declares
  it — it is what happens in the absence of one, and it must not read as a
  written allow. The overview is untouched: drawing this for every unprotected
  workload is the hairball that made the graph unreadable.

## [0.1.2] - 2026-08-06

### Fixed

- A namespace with only a few workloads is no longer magnified until it fills
  the viewport. Sigma scales whatever it is given to fit; card *drawing* was
  clamped to a readable band but card *positions* were not, so three cards
  stayed their normal size while the gaps between them grew to most of the
  screen. Zoom now refuses to magnify past 1:1, and the camera's maximum ratio
  rises to accommodate framing that genuinely needs it.

## [0.1.1] - 2026-08-06

### Fixed

- A namespace whose workloads no policy selects no longer renders as a column of
  dots. Dagre ranks by edges and openness is drawn on the card rather than as
  edges to a hub, so an unprotected namespace has no edges at all and every node
  landed in rank 0. Those namespaces now lay out as a grid.
- The camera stays where the user puts it. The stream sends a fresh graph on
  any cluster change — a Job finishing, a Deployment scaling — and each one used
  to drag the view away from whatever was being read. Only asking to see
  something different reframes: a level switch, a namespace scope, a filter.
- Panning is detected on the window rather than the stage, so a drag that ends
  with the pointer off the canvas is still a pan.
- Fitting pads each axis independently instead of falling back to a magic
  constant when one axis has no span.

### Changed

- The README shows the dashboard.

## [0.1.0] - 2026-08-06

First release.

### Added

- **`pkg/npeval`**, the evaluation core: which policies select a workload, what
  the effective ingress and egress allow-sets are, whether the workload is
  isolated, and whether a hypothetical connection would be allowed — with the
  rule that produced every answer. No HTTP, no UI, no client-go, so the same
  code can back a server, a CLI, and a CI check.
- **Providers** for `networking.k8s.io/v1` NetworkPolicy (ipBlock, selectors,
  ports, endPort, named ports, both policyTypes) and
  `networking.k8s.aws/v1alpha1` ApplicationNetworkPolicy including
  `domainNames`, detected through discovery. On a cluster without the CRD,
  Marsad says so rather than pretending the rules exist.
- **The read-only API**: `/api/meta`, `/api/namespaces`, `/api/graph`,
  `/api/workloads/{ns}/{name}`, `/api/simulate`, and `/api/stream`, a WebSocket
  carrying a fresh graph on every cluster change. Shared informers watch the
  cluster; the graph is recomputed on change, never polled.
- **The dashboard**: namespaces as containers, workloads as cards, each
  destination's open ports on the card that accepts them. Aggregates at the
  namespace level and drills down on demand. WebGL rendering, so clusters with
  thousands of pods stay interactive.
- **Simulation in the UI** — would this pod reach that one, on this port —
  answering on both the egress and the ingress side, which is the half people
  usually forget.
- **Unprotected workloads called out** on the card, rather than left to be
  inferred from absent edges.
- **A distroless image** for `linux/amd64` and `linux/arm64`, running as
  non-root with no shell and no package manager, and a minimal ClusterRole of
  `get`, `list` and `watch`.
- **A Helm chart**, published to GHCR as an OCI artifact, whose rendered
  ClusterRole CI asserts grants nothing but reads.
- **A kind rig** (`make kind-up`) with the AWS CRD and `examples/` applied, and
  a Docker-only toolchain so no Go, Node, or Kubernetes tooling is needed
  locally.

[Unreleased]: https://github.com/FathiQ/marsad/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/FathiQ/marsad/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/FathiQ/marsad/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/FathiQ/marsad/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/FathiQ/marsad/releases/tag/v0.1.0
