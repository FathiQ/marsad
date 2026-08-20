package graph

import "slices"

// DefaultSystemNamespaces are the namespaces a cluster operator did not create
// and is rarely asking about.
//
// Marsad's headline number counts them, and on a fresh cluster they are
// frequently the *only* unprotected workloads there are — which is how the
// product's loudest signal ends up pointing at infrastructure nobody is going
// to write a NetworkPolicy for. They are still counted and still reachable;
// they are just not the first thing the graph spends its space on.
//
// Configurable rather than fixed, because "system" is a local judgement: a
// platform team's own namespace is system to the application teams and the
// whole job to them.
var DefaultSystemNamespaces = []string{
	"kube-system",
	"kube-public",
	"kube-node-lease",
	"local-path-storage",
	"gatekeeper-system",
	"cert-manager",
}

// systemSet resolves the configured list, falling back to the default. An
// explicitly empty list means "treat nothing as system", which is why this
// distinguishes nil from empty.
func systemSet(configured []string, own string) map[string]bool {
	list := configured
	if list == nil {
		list = DefaultSystemNamespaces
	}
	out := make(map[string]bool, len(list)+1)
	for _, ns := range list {
		out[ns] = true
	}
	// Marsad's own namespace. Watching yourself watch the cluster is a
	// distraction from whatever you opened this to look at.
	if own != "" {
		out[own] = true
	}
	return out
}

// isSystem reports whether a namespace is collapsed by default.
func (b *builder) isSystem(namespace string) bool {
	if b.system == nil {
		return false
	}
	if slices.Contains(b.opts.Expand, namespace) {
		return false
	}
	return b.system[namespace]
}
