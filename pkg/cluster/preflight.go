package cluster

import (
	"fmt"
	"strings"
)

// Preflight verifies the connection before any informer starts.
//
// Without it, bad credentials surface as an endless stream of reflector errors
// from deep inside client-go while the process sits there looking alive. One
// clear message at startup is worth more than a thousand of those, particularly
// for the most common cause: an expired SSO session.
//
// Note what it does *not* catch. It asks for the server version, which most
// clusters allow any authenticated caller to read whatever their RBAC says, so
// a token that cannot list Deployments passes this and fails later at cache
// sync. That is why the watcher records watch errors too.
func Preflight(c *Clients) *Fault {
	if _, err := c.Discovery.ServerVersion(); err != nil {
		return NewFault(fmt.Errorf("cannot reach the Kubernetes API at %s: %w", c.Host, err), c.Host)
	}
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

func isConnectionError(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "connection refused") ||
		strings.Contains(msg, "no such host") ||
		strings.Contains(msg, "i/o timeout")
}
