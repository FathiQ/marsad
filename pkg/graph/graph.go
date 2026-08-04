// Package graph turns npeval's evaluation into the node-and-edge model the UI
// renders.
//
// The central concern here is scale. A cluster with thousands of pods produces a
// graph no one can read and no renderer can lay out, so the graph is built at a
// chosen level of aggregation and peers outside the current scope collapse to
// their namespace rather than expanding into hundreds of individual nodes.
package graph

import (
	"fmt"
	"net/netip"
	"slices"

	"github.com/FathiQ/marsad/pkg/npeval"
)

// Level is how much the graph is aggregated.
type Level string

const (
	// LevelNamespace draws one node per namespace. This is the default view,
	// because it is the only one that stays legible on a large cluster.
	LevelNamespace Level = "namespace"
	// LevelWorkload draws one node per controller. Pods of one Deployment stay a
	// single node with a replica count.
	LevelWorkload Level = "workload"
)

// NodeKind discriminates what a node represents.
type NodeKind string

// The kinds of vertex the graph draws.
const (
	NodeNamespace NodeKind = "namespace"
	NodeWorkload  NodeKind = "workload"
	NodeCIDR      NodeKind = "cidr"
	// NodeWorld is the 0.0.0.0/0/::0 pseudo-node — everything outside the
	// cluster, drawn distinctly because reaching it is usually the finding.
	NodeWorld NodeKind = "world"
	// NodeDomain is an AWS ApplicationNetworkPolicy domain peer.
	NodeDomain NodeKind = "domain"
	// NodeAny is the peer a rule with no from/to list matches: literally
	// anything, in or out of the cluster.
	NodeAny NodeKind = "any"
)

// EdgeKind tells the UI how to draw an edge.
type EdgeKind string

const (
	// EdgeAllowed is traffic a rule explicitly permits.
	EdgeAllowed EdgeKind = "allowed"
	// EdgeDefault is traffic permitted only because nothing isolates the
	// workload. Drawn dashed: it is the absence of policy, not a decision.
	EdgeDefault EdgeKind = "default"
	// EdgeApproximate is an edge whose exact extent could not be decided from
	// configuration — see npeval.Allow.Approximate.
	EdgeApproximate EdgeKind = "approximate"
)

// Isolation summarises a node's posture for the UI badge.
type Isolation struct {
	Ingress bool `json:"ingress"`
	Egress  bool `json:"egress"`
}

// Node is one vertex.
type Node struct {
	ID    string   `json:"id"`
	Kind  NodeKind `json:"kind"`
	Label string   `json:"label"`

	Namespace    string `json:"namespace,omitempty"`
	WorkloadKind string `json:"workloadKind,omitempty"`
	Replicas     int    `json:"replicas,omitempty"`

	// Isolation is set for cluster nodes. At namespace level it is the
	// conservative summary: a namespace counts as isolated in a direction only
	// when every workload in it is, because one unprotected workload is what
	// matters.
	Isolation *Isolation `json:"isolation,omitempty"`

	// Workloads is how many workloads a namespace node aggregates.
	Workloads int `json:"workloads,omitempty"`
	// Unprotected is how many of them no policy selects at all.
	Unprotected int `json:"unprotected,omitempty"`
}

// Edge is one directed allowance, from source to target.
type Edge struct {
	ID     string   `json:"id"`
	Source string   `json:"source"`
	Target string   `json:"target"`
	Kind   EdgeKind `json:"kind"`

	// Ports is rendered on the edge label; empty means every port.
	Ports []string `json:"ports,omitempty"`
	// DNS marks an edge that only carries port 53, so the UI can fold the
	// unavoidable DNS fan-out away without hiding anything else.
	DNS bool `json:"dns,omitempty"`

	// Via names every rule that produced this edge. Clicking an edge and being
	// shown the exact lines of YAML responsible is the point of the whole tool,
	// and this field is what makes it possible.
	Via  []npeval.RuleID `json:"via"`
	Note string          `json:"note,omitempty"`
}

// Graph is a renderable view of the cluster.
type Graph struct {
	Level      Level    `json:"level"`
	Namespaces []string `json:"namespaces,omitempty"`
	Nodes      []Node   `json:"nodes"`
	Edges      []Edge   `json:"edges"`

	// Truncated is set when peers were collapsed to namespace nodes to keep the
	// graph legible. Never silently: the UI says so.
	Truncated bool `json:"truncated,omitempty"`
}

// Options configures a build.
type Options struct {
	Level Level
	// Namespaces scopes the graph. Empty means every namespace.
	Namespaces []string
	// IncludeDefault draws dashed edges for traffic allowed only by the absence
	// of policy. On a cluster with no policies at all this is every workload, so
	// it can be turned off.
	IncludeDefault bool
}

func nsID(name string) string { return "ns:" + name }

func workloadID(ref npeval.ObjectRef) string {
	return "wl:" + ref.Namespace + "/" + ref.Kind + "/" + ref.Name
}

func peerNodeID(kind NodeKind, key string) string {
	return string(kind) + ":" + key
}

func isWorld(p netip.Prefix) bool { return p.IsValid() && p.Bits() == 0 }

// portLabels renders an allow's ports for an edge label.
func portLabels(ports []npeval.PortRange) []string {
	if len(ports) == 0 {
		return nil
	}
	out := make([]string, 0, len(ports))
	for _, p := range ports {
		out = append(out, p.String())
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// onlyDNS reports whether every port in the set is 53. DNS edges are drawn from
// nearly every egress-isolated workload, so the UI needs to be able to fold them
// away as a group.
func onlyDNS(ports []npeval.PortRange) bool {
	if len(ports) == 0 {
		return false
	}
	for _, p := range ports {
		if p.AllPorts || p.From != 53 || p.To != 53 {
			return false
		}
	}
	return true
}

func edgeID(source, target string, kind EdgeKind) string {
	return fmt.Sprintf("%s|%s|%s", source, target, kind)
}

func joinPorts(a, b []string) []string {
	// An edge with no ports means every port, which subsumes any restriction.
	if len(a) == 0 || len(b) == 0 {
		return nil
	}
	out := append(slices.Clone(a), b...)
	slices.Sort(out)
	return slices.Compact(out)
}

func shortLabel(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max-1] + "…"
}
