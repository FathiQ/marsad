package cluster

import (
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/client-go/discovery"

	awsv1alpha1 "github.com/FathiQ/marsad/pkg/apis/awsanp/v1alpha1"
	"github.com/FathiQ/marsad/pkg/npeval/provider/awsanp"
	"github.com/FathiQ/marsad/pkg/npeval/provider/k8s"
)

// Capability records whether one policy type is usable on this cluster, and if
// not, why. The UI shows the reason rather than silently omitting a policy
// layer — a graph that quietly leaves out domain egress is worse than one that
// says it cannot see it.
type Capability struct {
	Provider  string `json:"provider"`
	Group     string `json:"group"`
	Resource  string `json:"resource"`
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}

// Capabilities is what the cluster supports.
type Capabilities struct {
	Policies []Capability `json:"policies"`
}

// Has reports whether a provider is usable.
func (c Capabilities) Has(provider string) bool {
	for _, p := range c.Policies {
		if p.Provider == provider {
			return p.Available
		}
	}
	return false
}

// Detect asks the discovery API which policy types this cluster serves.
//
// ApplicationNetworkPolicy is an AWS VPC CNI CRD, so it is absent everywhere
// except EKS clusters that have it installed. That is a normal state, not an
// error: Marsad degrades to NetworkPolicy alone and says so.
func Detect(d discovery.DiscoveryInterface) Capabilities {
	caps := Capabilities{}

	k8sGVR := k8s.Provider{}.GVR()
	caps.Policies = append(caps.Policies, probe(d, "k8s", k8sGVR.Group, k8sGVR.Version, k8sGVR.Resource))

	anpGVR := awsanp.Provider{}.GVR()
	anp := probe(d, awsanp.Name, anpGVR.Group, anpGVR.Version, anpGVR.Resource)
	if !anp.Available && anp.Reason == "" {
		anp.Reason = fmt.Sprintf("the %s CRD is not installed on this cluster", awsv1alpha1.Kind)
	}
	caps.Policies = append(caps.Policies, anp)

	return caps
}

func probe(d discovery.DiscoveryInterface, provider, group, version, resource string) Capability {
	c := Capability{Provider: provider, Group: group, Resource: resource}

	gv := group + "/" + version
	list, err := d.ServerResourcesForGroupVersion(gv)
	if err != nil {
		switch {
		case meta.IsNoMatchError(err) || discovery.IsGroupDiscoveryFailedError(err):
			c.Reason = fmt.Sprintf("%s is not served by this cluster", gv)
		case apierrors.IsNotFound(err):
			c.Reason = fmt.Sprintf("%s is not served by this cluster", gv)
		default:
			c.Reason = fmt.Sprintf("discovery for %s failed: %v", gv, err)
		}
		return c
	}

	for _, r := range list.APIResources {
		if r.Name != resource {
			continue
		}
		// Without list and watch there is nothing Marsad can do with the
		// resource, and failing here beats failing later inside an informer.
		if !hasVerbs(r.Verbs, "list", "watch") {
			c.Reason = fmt.Sprintf("%s is served but this account cannot list and watch it", resource)
			return c
		}
		c.Available = true
		return c
	}

	c.Reason = fmt.Sprintf("%s is not present in %s", resource, gv)
	return c
}

func hasVerbs(have []string, want ...string) bool {
	for _, w := range want {
		found := false
		for _, h := range have {
			if h == w {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
