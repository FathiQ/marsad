package cluster

import (
	"fmt"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
)

// Preflight verifies the connection before any informer starts.
//
// Without it, bad credentials surface as an endless stream of reflector errors
// from deep inside client-go while the process sits there looking alive. One
// clear message at startup is worth more than a thousand of those, particularly
// for the most common cause: an expired SSO session.
func Preflight(c *Clients) error {
	version, err := c.Discovery.ServerVersion()
	if err != nil {
		return fmt.Errorf("cannot reach the Kubernetes API at %s: %w%s", c.Host, err, hint(err))
	}
	_ = version
	return nil
}

// ServerVersion returns the cluster version for the UI header.
func ServerVersion(c *Clients) string {
	v, err := c.Discovery.ServerVersion()
	if err != nil {
		return ""
	}
	return v.GitVersion
}

// hint turns the common authentication failures into something actionable.
func hint(err error) string {
	switch {
	case apierrors.IsUnauthorized(err):
		return "\n\nThe API server rejected the credentials. If this is an EKS cluster reached " +
			"through AWS SSO, the session has most likely expired — run `aws sso login` on the " +
			"host (with --profile if you use one) and try again. The kubeconfig and ~/.aws are " +
			"mounted read-only into the container, so refreshing them on the host is enough."

	case apierrors.IsForbidden(err):
		return "\n\nThe credentials are valid but lack permission. Marsad needs get, list and " +
			"watch on namespaces, pods, deployments, statefulsets, daemonsets, replicasets, jobs, " +
			"cronjobs and networkpolicies. See deploy/rbac.yaml for the minimal ClusterRole."

	case isConnectionError(err):
		return "\n\nThe API server was unreachable. If the cluster is only reachable through a " +
			"local proxy or a VPN on the host, the container will not see it: point --kubeconfig " +
			"at a reachable endpoint, or use host.docker.internal instead of 127.0.0.1."

	default:
		return ""
	}
}

func isConnectionError(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "connection refused") ||
		strings.Contains(msg, "no such host") ||
		strings.Contains(msg, "i/o timeout")
}
