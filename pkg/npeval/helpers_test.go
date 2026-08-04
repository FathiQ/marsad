package npeval_test

import (
	"fmt"
	"testing"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"

	awsv1alpha1 "github.com/FathiQ/marsad/pkg/apis/awsanp/v1alpha1"
	"github.com/FathiQ/marsad/pkg/npeval"
	"github.com/FathiQ/marsad/pkg/npeval/provider/awsanp"
	"github.com/FathiQ/marsad/pkg/npeval/provider/k8s"
)

// build assembles a snapshot from a mixed bag of namespaces, workloads and raw
// policy objects, normalizing the policies through their real providers so the
// tests exercise the same path the server does.
func build(t *testing.T, objs ...any) *npeval.Evaluator {
	t.Helper()

	b := npeval.NewBuilder()
	var opts []npeval.Option

	for _, o := range objs {
		switch v := o.(type) {
		case npeval.Namespace:
			b.AddNamespace(v)
		case npeval.Workload:
			b.AddWorkload(v)
		case *networkingv1.NetworkPolicy:
			p, err := k8s.NormalizePolicy(v)
			if err != nil {
				t.Fatalf("normalize %s/%s: %v", v.Namespace, v.Name, err)
			}
			b.AddPolicy(p)
		case *awsv1alpha1.ApplicationNetworkPolicy:
			p, err := awsanp.NormalizePolicy(v)
			if err != nil {
				t.Fatalf("normalize anp %s/%s: %v", v.Namespace, v.Name, err)
			}
			b.AddPolicy(p)
		case npeval.Option:
			opts = append(opts, v)
		default:
			t.Fatalf("build: unsupported object %T", o)
		}
	}

	snap, err := b.Build()
	if err != nil {
		t.Fatalf("build snapshot: %v", err)
	}
	return npeval.New(snap, opts...)
}

func namespace(name string, kv ...string) npeval.Namespace {
	return npeval.Namespace{Name: name, Labels: labelMap(kv...)}
}

func deploy(ns, name string, kv ...string) npeval.Workload {
	return npeval.Workload{
		Ref:      npeval.ObjectRef{Kind: "Deployment", Namespace: ns, Name: name},
		Kind:     npeval.KindDeployment,
		Labels:   labelMap(kv...),
		Replicas: 1,
	}
}

// withPorts attaches container ports, used by the named-port cases.
func withPorts(w npeval.Workload, ports ...npeval.NamedPort) npeval.Workload {
	w.Ports = ports
	return w
}

func deployRef(ns, name string) npeval.ObjectRef {
	return npeval.ObjectRef{Kind: "Deployment", Namespace: ns, Name: name}
}

func labelMap(kv ...string) map[string]string {
	if len(kv)%2 != 0 {
		panic("labelMap needs key/value pairs")
	}
	m := make(map[string]string, len(kv)/2)
	for i := 0; i < len(kv); i += 2 {
		m[kv[i]] = kv[i+1]
	}
	return m
}

// sel builds a matchLabels selector. sel() with no arguments is the empty
// selector, which matches everything.
func sel(kv ...string) *metav1.LabelSelector {
	return &metav1.LabelSelector{MatchLabels: labelMap(kv...)}
}

func netpol(ns, name string, spec networkingv1.NetworkPolicySpec) *networkingv1.NetworkPolicy {
	return &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name},
		Spec:       spec,
	}
}

func anp(ns, name string, spec awsv1alpha1.ApplicationNetworkPolicySpec) *awsv1alpha1.ApplicationNetworkPolicy {
	return &awsv1alpha1.ApplicationNetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name},
		Spec:       spec,
	}
}

func proto(p corev1.Protocol) *corev1.Protocol { return &p }

func portNum(n int32) *intstr.IntOrString {
	v := intstr.FromInt32(n)
	return &v
}

func portName(s string) *intstr.IntOrString {
	v := intstr.FromString(s)
	return &v
}

func i32(n int32) *int32 { return &n }

// allowSummary renders an effective allow-set as sorted "peer => ports" strings,
// which makes the assertions read like the graph edges they describe.
func allowSummary(e npeval.Effective) []string {
	out := make([]string, 0, len(e.Allows))
	for _, a := range e.Allows {
		ports := "all ports"
		if len(a.Ports) > 0 {
			ports = ""
			for i, p := range a.Ports {
				if i > 0 {
					ports += ","
				}
				ports += p.String()
			}
		}
		out = append(out, fmt.Sprintf("%s => %s", a.Peer.Display, ports))
	}
	return out
}

// peerWorkloads returns the workloads the single expected allow resolves to.
func peerWorkloads(t *testing.T, e npeval.Effective) []npeval.ObjectRef {
	t.Helper()
	if len(e.Allows) != 1 {
		t.Fatalf("expected exactly one allow, got %d: %v", len(e.Allows), allowSummary(e))
	}
	return e.Allows[0].Peer.Workloads
}

func refNames(refs []npeval.ObjectRef) []string {
	out := make([]string, len(refs))
	for i, r := range refs {
		out[i] = r.Namespace + "/" + r.Name
	}
	return out
}
