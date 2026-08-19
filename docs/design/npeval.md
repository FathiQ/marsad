# `pkg/npeval` — policy evaluation core

Status: **design accepted**; AWS CRD schema confirmed against a live cluster
(`applicationnetworkpolicies.networking.k8s.aws` v1alpha1, controller-gen v0.17.0).

`npeval` answers, from *declared configuration only*: which policies select a
workload, what the effective ingress/egress allow-set is, whether the workload is
isolated, and whether a hypothetical connection would be allowed — and for every
answer, *which rule produced it*.

## Design rules

1. **No I/O, no HTTP, no client-go.** The package takes an immutable snapshot of
   already-fetched objects. This is what lets the same code back the server, a
   CLI (`marsad lint ./policies/`), and a CI check.
2. **Dependency floor:** stdlib + `k8s.io/apimachinery` (`metav1.LabelSelector`,
   `labels`). Reimplementing `matchExpressions` is a bug farm; apimachinery is a
   light, types-only dep. `k8s.io/api` is used *only* by providers, not the core.
3. **Traceability is a first-class output, not a debug aid.** Every allow entry
   and every verdict carries `[]RuleID` naming the exact rules that produced it.
   The UI's edge-click feature is a direct read of this field.
4. **Immutable snapshots.** The informer layer builds a new `Snapshot` and swaps
   it atomically. Evaluators are read-only and safe for concurrent use; no locks
   in the hot path.
5. **Deterministic output.** All slices sorted by stable keys, so graph diffs
   and golden tests are stable.

## Package layout

```
pkg/npeval/                    core: model, snapshot, evaluator   (apimachinery only)
pkg/npeval/provider/k8s/       networking.k8s.io/v1 NetworkPolicy
pkg/npeval/provider/awsanp/    networking.k8s.aws/v1alpha1 ApplicationNetworkPolicy
pkg/apis/awsanp/v1alpha1/      Go types for the CRD (not published upstream)
pkg/findings/                  security rules — consumes npeval's public API only
```

Cilium/Calico later = a new `provider/` package + `Capabilities{DenyRules,
Ordering: true}`. No core changes.

---

## 1. Object model

```go
type ObjectRef struct {
	Group     string // "" for core, "networking.k8s.io", "networking.k8s.aws"
	Kind      string // "Deployment", "NetworkPolicy", ...
	Namespace string
	Name      string
}

type Namespace struct {
	Name   string
	Labels map[string]string
}

type WorkloadKind string // Deployment | StatefulSet | DaemonSet | Job | CronJob | Pod

// Workload is the graph's unit: one node per controller, not per pod.
type Workload struct {
	Ref      ObjectRef
	Kind     WorkloadKind
	Labels   map[string]string // POD TEMPLATE labels — what policies select on
	Replicas int               // for the badge; 1 for a bare Pod
	Ports    []NamedPort       // container ports, for resolving named-port rules
}

type NamedPort struct {
	Name     string
	Port     int32
	Protocol Protocol
}

type Protocol string // "TCP" | "UDP" | "SCTP"; TCP is the API default
```

> Note the comment on `Labels`: policies select **pods**, so a Deployment node is
> only a valid unit if all its pods share the template labels. True in practice;
> the informer layer builds `Workload` from `spec.template.metadata.labels` and
> attributes orphan pods to a synthetic `Kind: Pod` workload.

## 2. Normalized policy model

Providers translate their native types into this. It is deliberately more
explicit than the k8s API where the API's nil-vs-empty semantics are subtle.

```go
type Policy struct {
	Ref      ObjectRef
	Provider string      // "k8s" | "aws-anp"
	Selector Selector    // which pods in Ref.Namespace this applies to
	Types    PolicyTypes // bitmask: TypeIngress | TypeEgress
	Ingress  []Rule
	Egress   []Rule
	Order    int         // rule precedence; always 0 for k8s and ANP (additive allow)
	Raw      any         // original object — powers the YAML viewer
}

type Rule struct {
	ID   RuleID // stable, e.g. "networkpolicy/prod/api-allow#ingress[2]"
	Path string // JSONPath into Raw: "spec.ingress[2]" — for UI highlighting

	// AllPeers is true when from/to was empty or omitted → matches every peer.
	// When false, Peers are OR-ed.
	AllPeers bool
	Peers    []Peer

	// AllPorts is true when ports was empty or omitted → every port/protocol.
	AllPorts bool
	Ports    []PortRange
}

type PeerKind int
const (
	PeerPods   PeerKind = iota // namespaceSelector and/or podSelector
	PeerCIDR                   // ipBlock
	PeerDomain                 // AWS ANP domainNames
	PeerEntity                 // reserved for Cilium-style world/host/remote-node
)

type Peer struct {
	Kind PeerKind
	Path string // "spec.egress[0].to[1]" — peer-level traceability

	// PeerPods. nil NamespaceSelector = "the policy's own namespace".
	// Non-nil-but-empty = "all namespaces". Both selectors on one Peer are ANDed;
	// separate Peers in the same Rule are ORed. This is THE classic footgun.
	NamespaceSelector *Selector
	PodSelector       *Selector

	// PeerCIDR
	CIDR   netip.Prefix
	Except []netip.Prefix

	// PeerDomain — may be a wildcard: "*.s3.us-east-1.amazonaws.com"
	Domain string
}

type PortRange struct {
	Protocol Protocol
	AllPorts bool   // NetworkPolicyPort with protocol set but port omitted
	Name     string // named port; From/To resolved per-workload at eval time
	From, To int32  // inclusive; To == From when endPort is absent
}

// Selector wraps metav1.LabelSelector and caches the compiled labels.Selector.
type Selector struct { /* raw metav1.LabelSelector + compiled matcher */ }
func (s Selector) Matches(labels map[string]string) bool
func (s Selector) MatchesEverything() bool // {} → true
func (s Selector) String() string          // human-readable, for the UI
```

## 3. Snapshot

```go
type Snapshot struct{ /* opaque, immutable */ }

type Builder struct{}
func NewBuilder() *Builder
func (b *Builder) AddNamespace(Namespace) *Builder
func (b *Builder) AddWorkload(Workload) *Builder
func (b *Builder) AddPolicy(Policy) *Builder
func (b *Builder) Build() (*Snapshot, error)

func (s *Snapshot) Namespaces() []Namespace
func (s *Snapshot) Workloads(namespace string) []Workload  // "" = all
func (s *Snapshot) Policies(namespace string) []Policy
```

`Build()` precomputes, in one pass: compiled selectors, namespace-by-label index,
workload-by-namespace index, and the policy→selected-workloads mapping. That
last one is O(policies × workloads-in-namespace) once, instead of on every query.

## 4. Evaluator

```go
type Evaluator struct{ /* holds *Snapshot */ }
func New(s *Snapshot, opts ...Option) *Evaluator
```

### 4.1 Which policies apply

```go
type PolicyMatch struct {
	Policy ObjectRef
	Types  PolicyTypes // what this policy contributes for this workload
}
func (e *Evaluator) PoliciesFor(w ObjectRef) []PolicyMatch
func (e *Evaluator) SelectedBy(p ObjectRef) []ObjectRef // inverse; powers the "dead policy" finding
```

### 4.2 Isolation — **per provider layer**

```go
type Isolation struct {
	Ingress   bool
	Egress    bool
	IngressBy []ObjectRef
	EgressBy  []ObjectRef
}
func (e *Evaluator) Isolation(w ObjectRef) Isolation                     // any layer
func (e *Evaluator) IsolationByProvider(w ObjectRef) map[string]Isolation
```

Semantics: a workload selected by **any** policy whose `policyTypes` contains
`Ingress` is ingress-isolated — *even if that policy's ingress rules are empty*
(that is precisely default-deny). Unselected pods are wide open in both
directions. Same, independently, for egress. Isolation is computed **separately
per provider** — see §5.

### 4.3 Effective allow-set — the graph's data source

```go
type Direction int // DirIngress | DirEgress

type Layer struct {
	Provider string  // "k8s" | "aws-anp"
	Isolated bool
	By       []ObjectRef
	Allows   []Allow // union of this provider's rules
}

type Effective struct {
	Workload  ObjectRef
	Direction Direction
	Isolated  bool    // true if ANY layer isolates
	Layers    []Layer // per-provider, always populated
	Allows    []Allow // layers combined — see §5
}

type Allow struct {
	Peer  ResolvedPeer
	Ports []PortRange // named ports resolved to numbers where possible
	Via   []RuleID    // every rule that contributed — traceability

	// Approximate is set when combining layers could not be decided statically
	// (e.g. a domain peer intersected with a CIDR peer). Note explains why.
	Approximate bool
	Note        string
}

type ResolvedPeer struct {
	Kind PeerKind

	// PeerPods, resolved against the current snapshot:
	Namespaces []string    // namespaces the namespaceSelector matched
	Workloads  []ObjectRef // concrete workloads matched right now
	Display    string      // "ns=prod, app in (api,web)" — for the edge label

	CIDR   netip.Prefix
	Except []netip.Prefix
	Domain string
}

func (e *Evaluator) Effective(w ObjectRef, d Direction) Effective
func (e *Evaluator) EffectiveAll(namespaces ...string) []Effective // bulk graph build
```

`Isolated: false` is what the UI renders as gray-dashed "allowed by default"
edges. Keeping the flag rather than synthesizing an allow-everything entry keeps
that visually distinct case explicit in the data.

## 5. Cross-provider combination — **corrected after reading the CRD**

The original design assumed one flat allow-set. The ANP CRD's own field docs say
otherwise:

> *Outgoing traffic is allowed if there are no ApplicationNetworkPolicies
> selecting the pod **(and cluster policy otherwise allows the traffic)**, OR if
> the traffic matches at least one egress rule across all of the
> ApplicationNetworkPolicy objects whose podSelector matches the pod.*

So ANP is a **second, independent policy layer**, not more rules in the same
pool. Within a layer, rules **union**. Across layers, the parenthetical says
NetworkPolicy must *also* allow — i.e. layers **intersect**.

The sentence is genuinely ambiguous: read strictly, the second disjunct doesn't
re-require cluster policy, which would let an ANP override a NetworkPolicy deny.
That reading is almost certainly not the intent, but we should not silently bet a
security tool on either.

**Decision:** compute and expose every layer separately (`Effective.Layers`), and
present `Effective.Allows` as the **conservative intersection** by default,
configurable:

```go
type CombineMode int
const (
	CombineIntersect CombineMode = iota // default: traffic must satisfy every isolating layer
	CombineUnion                        // any isolating layer may permit
)
func WithCombineMode(CombineMode) Option
```

The UI shows layers side by side, so the user always sees the raw per-layer truth
regardless of the combine mode.

### 5.1 Peer intersection decidability

| left ∩ right | result |
|---|---|
| pods ∩ pods | intersection of resolved workload sets — exact |
| cidr ∩ cidr | prefix intersection, `except` unioned — exact |
| domain ∩ domain | glob containment (see §7) — exact |
| domain ∩ cidr | **undecidable statically** — emit the domain peer with `Approximate: true` |
| pods ∩ cidr | assumed empty (pod IPs are cluster-internal); flagged, not silently dropped |

Ports intersect as ranges; `AllPorts` is the identity element.

## 6. Simulate

```go
type Endpoint struct { // exactly one field set
	Workload *ObjectRef
	CIDR     *netip.Prefix
	Domain   string
}

type Query struct {
	From, To Endpoint
	Protocol Protocol
	Port     int32
}

type Result int  // ResultAllowed | ResultDenied | ResultNotApplicable
type Reason int  // ReasonNotIsolated | ReasonMatchedRule | ReasonNoMatchingRule |
                 // ReasonNoPolicySelects | ReasonPeerUnresolvable

type Decision struct {
	Result   Result
	Reason   Reason
	Via      []RuleID
	Explain  string // "allowed by netpol prod/api-allow spec.egress[0].to[1] (443/TCP)"
	ByLayer  map[string]Result
}

type Verdict struct {
	Allowed bool     // Egress.Result != Denied && Ingress.Result != Denied
	Egress  Decision // evaluated on From (NotApplicable if From isn't a workload)
	Ingress Decision // evaluated on To   (NotApplicable if To isn't a workload)
}

func (e *Evaluator) Simulate(q Query) (Verdict, error)
```

Both directions must permit: pod→pod needs the source's egress *and* the
destination's ingress to allow. This is the #1 thing people get wrong when
hand-reading policies, and showing both halves separately is what makes the
Simulate panel worth building.

## 7. Domain matching — confirmed by the CRD

The CRD pins the semantics exactly, and they are **broader than a typical glob**:

- `*` is a prefix-only wildcard and matches **one or more entire labels**.
- `kubernetes.io` matches only `kubernetes.io`.
- `*.kubernetes.io` matches `www.kubernetes.io`, `blog.kubernetes.io`, **and
  `latest.blog.kubernetes.io`** — but *not* `kubernetes.io` itself.
- No partial-label matches (`my-*.io` is invalid).
- Trailing dot allowed by the pattern; normalize it away.

Regex from the CRD:
`^(\*\.)?([a-zA-z0-9]([-a-zA-Z0-9_]*[a-zA-Z0-9])?\.)+[a-zA-z0-9]([-a-zA-Z0-9_]*[a-zA-Z0-9])?\.?$`

That `*` spans multiple labels is exactly why the MEDIUM "overly broad wildcard"
finding matters: `*.amazonaws.com` reaches every AWS service in every region.

## 8. What the CRD confirmed vs. changed

Confirmed as designed:
- `spec.egress[].to[].domainNames[]` — the `PeerDomain` shape is correct.
- Domain peers are **egress-only**; ANP `ingress` uses the stock
  `NetworkPolicyIngressRule`/`NetworkPolicyPeer`, no domains.
- `policyTypes` defaulting language is identical to NetworkPolicy.
- `endPort` cannot combine with a named port.
- Empty-or-missing `from`/`to`/`ports` all mean "unrestricted".

Changed or newly pinned:
- **Layering** — §5. The big one.
- `domainNames` is a **list per peer** (`minItems: 1`, `x-kubernetes-list-type: set`).
  Normalization expands it into one `PeerDomain` per name, each carrying
  `Path: "spec.egress[0].to[1].domainNames[2]"`, so the graph gets one cloud node
  per domain while traceability stays exact.
- CEL validation makes `domainNames` mutually exclusive with `podSelector`,
  `namespaceSelector`, **and** `ipBlock`. `Normalize` enforces this and returns an
  error rather than guessing.
- `spec.podSelector` is **required** on ANP (it is optional-with-default on
  NetworkPolicy). A missing one is a malformed object, not "select all".
- ANP ingress additionally always allows **traffic from the pod's own node**
  (kubelet probes). Modeled as an implicit note on ingress layers, not a peer —
  otherwise every node would become a graph node.

## 9. Semantics table — the edge cases tests must pin

| Input | Meaning |
|---|---|
| `podSelector: {}` on a policy | selects **all** pods in the namespace |
| `spec.ingress` omitted or `[]`, `policyTypes: [Ingress]` | isolated, **deny all** ingress |
| `ingress: [{}]` | isolated, **allow all** ingress |
| `from` omitted **or** `from: []` | allow from all sources (both, per upstream API docs) |
| `ports` omitted or `[]` | all ports and protocols |
| `NetworkPolicyPort{protocol: TCP}` with no `port` | all TCP ports |
| `policyTypes` omitted | `[Ingress]`, plus `Egress` iff `spec.egress` is non-empty |
| one peer with both `namespaceSelector` + `podSelector` | AND |
| two peers, one each | OR |
| `namespaceSelector` omitted in a peer | the policy's own namespace |
| `namespaceSelector: {}` | all namespaces |
| `podSelector` omitted in a peer | all pods in the matched namespaces |
| `ipBlock` + selectors in one peer | invalid → `Normalize` errors |
| `domainNames` + any selector or `ipBlock` | invalid per CEL → `Normalize` errors |
| `endPort` | inclusive range `[port, endPort]`; `port` must be numeric |
| named port, ingress rule | resolves against the **policy-selected** pods |
| named port, egress rule | resolves against the **destination** pods |
| two policies, same provider, selecting one pod | **union** of allows |
| two policies, different providers | **intersection** (default `CombineIntersect`) |
| `except` outside `cidr` | invalid → `Normalize` errors |
| `*.kubernetes.io` | matches `a.kubernetes.io` and `a.b.kubernetes.io`, not `kubernetes.io` |

## 10. Settled defaults

- Wildcard matching: multi-label, per the CRD (§7).
- Bare pods → `Kind: Pod` workloads; ReplicaSet-owned pods attributed to the Deployment.
- Module path placeholder: `github.com/marsad-io/marsad`.
- All development runs in Docker; no host toolchain. See `docs/development.md`.
