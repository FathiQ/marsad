// Package npeval evaluates declared Kubernetes network policy.
//
// It answers, from configuration alone and without contacting a cluster: which
// policies select a workload, what its effective ingress and egress allow-sets
// are, whether it is isolated, and whether a hypothetical connection would be
// permitted — always naming the exact rules responsible.
//
// The package performs no I/O and does not depend on client-go. Callers build an
// immutable [Snapshot] from objects they have already fetched (informers, a
// directory of YAML, a test fixture) and evaluate against it. Snapshots are
// immutable, so an [Evaluator] is safe for concurrent use; a watch layer swaps in
// a new snapshot rather than mutating one in place.
//
// Provider packages under provider/ translate vendor policy types into the
// normalized [Policy] model. Rules from different providers form independent
// layers: within a layer they union, across layers they combine per
// [CombineMode]. See docs/design/npeval.md.
package npeval
