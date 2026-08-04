// Package cluster watches a Kubernetes cluster and turns what it sees into
// npeval snapshots.
//
// Everything here is read-only. The clients are constructed from configs that
// only ever issue get, list and watch; there is no write path in this package,
// not a disabled one but an absent one.
package cluster

import (
	"fmt"

	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// Clients bundles the three clients the watcher needs.
type Clients struct {
	Kube      kubernetes.Interface
	Dynamic   dynamic.Interface
	Discovery discovery.DiscoveryInterface

	// Host is the API server the config points at, for logging and the UI's
	// "which cluster am I looking at" header.
	Host string
}

// RESTConfig loads cluster credentials, preferring in-cluster configuration and
// falling back to a kubeconfig.
//
// kubeconfigPath may be empty, in which case the usual precedence applies:
// in-cluster service account, then $KUBECONFIG, then ~/.kube/config.
func RESTConfig(kubeconfigPath string) (*rest.Config, error) {
	if kubeconfigPath == "" {
		if cfg, err := rest.InClusterConfig(); err == nil {
			return cfg, nil
		}
	}

	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	if kubeconfigPath != "" {
		rules.ExplicitPath = kubeconfigPath
	}

	cfg, err := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		rules, &clientcmd.ConfigOverrides{}).ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("load kubeconfig: %w", err)
	}
	return cfg, nil
}

// NewClients builds the clients from a REST config.
func NewClients(cfg *rest.Config) (*Clients, error) {
	// Marsad lists a lot at startup and then watches. The client-go defaults
	// (5 QPS) make the initial sync needlessly slow on a large cluster.
	cfg = rest.CopyConfig(cfg)
	if cfg.QPS == 0 {
		cfg.QPS = 50
		cfg.Burst = 100
	}
	cfg.UserAgent = "marsad"

	kube, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("kubernetes client: %w", err)
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("dynamic client: %w", err)
	}
	disc, err := discovery.NewDiscoveryClientForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("discovery client: %w", err)
	}

	return &Clients{Kube: kube, Dynamic: dyn, Discovery: disc, Host: cfg.Host}, nil
}
