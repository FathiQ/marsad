package cluster

import (
	"fmt"
	"strings"

	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/yaml"
)

// FaultKind classifies why Marsad cannot read the cluster.
type FaultKind string

// The ways connecting to a cluster goes wrong, in the order they are worth
// distinguishing: each one has a different fix, and telling someone "cannot
// reach the cluster" when the truth is "your token lacks a verb" sends them to
// the wrong place entirely.
const (
	FaultForbidden    FaultKind = "forbidden"
	FaultUnauthorized FaultKind = "unauthorized"
	FaultUnreachable  FaultKind = "unreachable"
	FaultOther        FaultKind = "other"
)

// Fault is a startup failure, described well enough to act on.
//
// It carries the API server's own words. Every layer between the operator and
// that sentence is a layer that can paraphrase it into something that sounds
// like a different problem, and the one thing somebody debugging RBAC needs is
// the resource and verb the server actually named.
type Fault struct {
	Kind FaultKind `json:"kind"`
	// Message is the error verbatim, not a summary of it.
	Message string `json:"message"`
	// Hint is Marsad's reading of it, kept separate so it can never be mistaken
	// for something the cluster said.
	Hint string `json:"hint,omitempty"`
	// Host is which API server refused.
	Host string `json:"host,omitempty"`
}

// NewFault classifies an error from the API server.
func NewFault(err error, host string) *Fault {
	if err == nil {
		return nil
	}
	f := &Fault{Kind: FaultOther, Message: err.Error(), Host: host}
	switch {
	case apierrors.IsForbidden(err):
		f.Kind = FaultForbidden
		f.Hint = "The credentials are valid but lack permission. Marsad only ever reads: " +
			"get, list and watch. Applying the ClusterRole below grants exactly that and nothing more."
	case apierrors.IsUnauthorized(err):
		f.Kind = FaultUnauthorized
		f.Hint = "The API server rejected the credentials. If this is an EKS cluster reached " +
			"through AWS SSO, the session has most likely expired — run `aws sso login` on the " +
			"host and try again."
	case isConnectionError(err):
		f.Kind = FaultUnreachable
		f.Hint = "The API server was unreachable. If the cluster is only reachable through a " +
			"local proxy or a VPN on the host, a container will not see it: point --kubeconfig " +
			"at a reachable endpoint, or use host.docker.internal instead of 127.0.0.1."
	}
	return f
}

func (f *Fault) Error() string {
	if f == nil {
		return ""
	}
	return f.Message
}

// requiredRules is the single source of truth for what Marsad needs.
//
// deploy/rbac.yaml is asserted against this in the tests, so the YAML a user is
// handed when permission is refused cannot drift from the YAML in the repo —
// which would be a peculiarly cruel way to fail, since the whole point of
// offering it is that it is the one that works.
func requiredRules() []rbacv1.PolicyRule {
	read := []string{"get", "list", "watch"}
	return []rbacv1.PolicyRule{
		{APIGroups: []string{""}, Resources: []string{"namespaces", "pods", "services"}, Verbs: read},
		{
			APIGroups: []string{groupApps},
			Resources: []string{"deployments", "statefulsets", "daemonsets", "replicasets"},
			Verbs:     read,
		},
		{APIGroups: []string{groupBatch}, Resources: []string{"jobs", "cronjobs"}, Verbs: read},
		{APIGroups: []string{"networking.k8s.io"}, Resources: []string{"networkpolicies"}, Verbs: read},
		{
			APIGroups: []string{"networking.k8s.aws"},
			Resources: []string{"applicationnetworkpolicies"},
			Verbs:     read,
		},
	}
}

// RequiredClusterRole renders the ClusterRole Marsad needs, ready to apply.
//
// Generated rather than quoted from the docs, so what is offered on screen is
// produced by the same list the tests check against deploy/rbac.yaml.
func RequiredClusterRole(name string) string {
	if name == "" {
		name = "marsad"
	}
	role := rbacv1.ClusterRole{
		TypeMeta: metav1.TypeMeta{
			APIVersion: "rbac.authorization.k8s.io/v1",
			Kind:       "ClusterRole",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:   name,
			Labels: map[string]string{"app.kubernetes.io/name": "marsad"},
		},
		Rules: requiredRules(),
	}

	b, err := yaml.Marshal(role)
	if err != nil {
		// Marshalling a struct with no cycles and no channels cannot fail, but
		// returning something applicable matters more than being clever here.
		return fmt.Sprintf("# could not render the ClusterRole: %v", err)
	}

	header := "# Marsad reads and never writes. These are get, list and watch,\n" +
		"# and nothing else.\n"
	return header + strings.TrimSpace(string(b)) + "\n"
}
