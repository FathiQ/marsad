package cluster_test

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/FathiQ/marsad/pkg/cluster"
	"github.com/FathiQ/marsad/pkg/npeval"
)

func ptr[T any](v T) *T { return &v }

func namespace(name string) *corev1.Namespace {
	return &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name}}
}

func deployment(ns, name string, labels map[string]string) *appsv1.Deployment {
	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: ns, Name: name,
			// Deliberately different from the template labels: a policy matches
			// the pods, never the controller, and confusing the two silently
			// mis-attributes every rule.
			Labels: map[string]string{"managed-by": "helm"},
		},
		Spec: appsv1.DeploymentSpec{
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{Containers: []corev1.Container{{
					Name:  "app",
					Ports: []corev1.ContainerPort{{Name: "http", ContainerPort: 8080}},
				}}},
			},
		},
	}
}

func replicaSet(ns, name, owner string) *appsv1.ReplicaSet {
	return &appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{
		Namespace: ns, Name: name,
		OwnerReferences: []metav1.OwnerReference{{
			APIVersion: "apps/v1", Kind: "Deployment", Name: owner, Controller: ptr(true),
		}},
	}}
}

func pod(ns, name string, labels map[string]string, owner *metav1.OwnerReference) *corev1.Pod {
	p := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name, Labels: labels},
		Status:     corev1.PodStatus{Phase: corev1.PodRunning},
	}
	if owner != nil {
		p.OwnerReferences = []metav1.OwnerReference{*owner}
	}
	return p
}

func owner(kind, name string) *metav1.OwnerReference {
	apiVersion := "apps/v1"
	if kind == "Rollout" {
		apiVersion = "argoproj.io/v1alpha1"
	}
	return &metav1.OwnerReference{APIVersion: apiVersion, Kind: kind, Name: name, Controller: ptr(true)}
}

// runWatcher starts a watcher over a fake cluster and waits for its first state.
func runWatcher(t *testing.T, objects ...runtime.Object) *cluster.State {
	t.Helper()

	kube := fake.NewClientset(objects...)
	clients := &cluster.Clients{Kube: kube, Host: "fake"}
	caps := cluster.Capabilities{Policies: []cluster.Capability{
		{Provider: "k8s", Available: true},
		{Provider: "aws-anp", Available: false, Reason: "not installed"},
	}}

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	w := cluster.NewWatcher(clients, caps, log)
	w.SetDebounce(10 * time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = w.Run(ctx) }()

	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if s := w.State(); s != nil && s.Snapshot != nil {
			return s
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("watcher produced no state")
	return nil
}

func findWorkload(t *testing.T, s *cluster.State, ns, kind, name string) npeval.Workload {
	t.Helper()
	for _, w := range s.Snapshot.Workloads(ns) {
		if w.Ref.Kind == kind && w.Ref.Name == name {
			return w
		}
	}
	t.Fatalf("no %s %s/%s in snapshot; have %v", kind, ns, name, workloadNames(s))
	return npeval.Workload{}
}

func workloadNames(s *cluster.State) []string {
	var out []string
	for _, w := range s.Snapshot.Workloads("") {
		out = append(out, w.Ref.Kind+"/"+w.Ref.Namespace+"/"+w.Ref.Name)
	}
	return out
}

func TestWatcherAttributesPodsToControllers(t *testing.T) {
	state := runWatcher(t,
		namespace("prod"),
		deployment("prod", "api", map[string]string{"app": "api"}),
		replicaSet("prod", "api-7d9f", "api"),
		pod("prod", "api-7d9f-aaa", map[string]string{"app": "api"}, owner("ReplicaSet", "api-7d9f")),
		pod("prod", "api-7d9f-bbb", map[string]string{"app": "api"}, owner("ReplicaSet", "api-7d9f")),
	)

	api := findWorkload(t, state, "prod", "Deployment", "api")

	// The pod template labels are what policies select on, not the Deployment's.
	if api.Labels["app"] != "api" {
		t.Errorf("labels = %v, want the pod template labels", api.Labels)
	}
	if api.Labels["managed-by"] != "" {
		t.Error("the controller's own labels must not leak into the node")
	}
	// Two pods behind one Deployment are one node with a count, not two nodes.
	if api.Replicas != 2 {
		t.Errorf("replicas = %d, want 2", api.Replicas)
	}
	if len(api.Ports) != 1 || api.Ports[0].Name != "http" || api.Ports[0].Port != 8080 {
		t.Errorf("named ports = %+v", api.Ports)
	}

	for _, name := range workloadNames(state) {
		if name == "ReplicaSet/prod/api-7d9f" {
			t.Error("ReplicaSets are an implementation detail and must not be nodes")
		}
	}
	if got := len(state.Snapshot.Workloads("prod")); got != 1 {
		t.Errorf("got %d workloads, want just the Deployment: %v", got, workloadNames(state))
	}
}

// A pod nothing owns is exactly the kind of thing that ends up unprotected, so
// it gets its own node rather than being dropped.
func TestWatcherKeepsBarePods(t *testing.T) {
	state := runWatcher(t,
		namespace("prod"),
		pod("prod", "debug", map[string]string{"app": "debug"}, nil),
	)

	debug := findWorkload(t, state, "prod", "Pod", "debug")
	if debug.Kind != npeval.KindPod {
		t.Errorf("kind = %q", debug.Kind)
	}
	if debug.Replicas != 1 {
		t.Errorf("replicas = %d", debug.Replicas)
	}
}

// An Argo Rollout, or any operator's own controller kind, is not something
// Marsad watches. Its pods still have to appear, grouped under the owner rather
// than scattered as individual pods or dropped entirely.
func TestWatcherGroupsPodsUnderUnknownControllers(t *testing.T) {
	state := runWatcher(t,
		namespace("prod"),
		pod("prod", "checkout-abc", map[string]string{"app": "checkout"}, owner("Rollout", "checkout")),
		pod("prod", "checkout-def", map[string]string{"app": "checkout"}, owner("Rollout", "checkout")),
	)

	rollout := findWorkload(t, state, "prod", "Rollout", "checkout")
	if rollout.Replicas != 2 {
		t.Errorf("replicas = %d, want both pods grouped", rollout.Replicas)
	}
	if rollout.Labels["app"] != "checkout" {
		t.Errorf("labels = %v", rollout.Labels)
	}
	if got := len(state.Snapshot.Workloads("prod")); got != 1 {
		t.Errorf("got %d workloads, want one grouped node: %v", got, workloadNames(state))
	}
}

func TestWatcherIgnoresCompletedPods(t *testing.T) {
	finished := pod("prod", "migrate-xyz", map[string]string{"app": "migrate"}, nil)
	finished.Status.Phase = corev1.PodSucceeded

	state := runWatcher(t, namespace("prod"), finished)

	if got := len(state.Snapshot.Workloads("prod")); got != 0 {
		t.Errorf("a completed pod is not running traffic: %v", workloadNames(state))
	}
}

func TestWatcherNormalizesPolicies(t *testing.T) {
	state := runWatcher(t,
		namespace("prod"),
		deployment("prod", "api", map[string]string{"app": "api"}),
		&networkingv1.NetworkPolicy{
			ObjectMeta: metav1.ObjectMeta{Namespace: "prod", Name: "deny-all"},
			Spec: networkingv1.NetworkPolicySpec{
				PodSelector: metav1.LabelSelector{},
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			},
		},
	)

	if state.Counts.Policies != 1 {
		t.Fatalf("policies = %d", state.Counts.Policies)
	}
	e := npeval.New(state.Snapshot)
	api := findWorkload(t, state, "prod", "Deployment", "api")
	if !e.Isolation(api.Ref).Ingress {
		t.Error("the policy should isolate the workload it selects")
	}
}

// One unreadable policy must not blank the graph: it becomes a warning and
// everything else still renders.
func TestWatcherWarnsOnMalformedPolicy(t *testing.T) {
	state := runWatcher(t,
		namespace("prod"),
		deployment("prod", "api", map[string]string{"app": "api"}),
		&networkingv1.NetworkPolicy{
			ObjectMeta: metav1.ObjectMeta{Namespace: "prod", Name: "broken"},
			Spec: networkingv1.NetworkPolicySpec{
				PodSelector: metav1.LabelSelector{},
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
				Ingress: []networkingv1.NetworkPolicyIngressRule{{
					From: []networkingv1.NetworkPolicyPeer{{
						IPBlock: &networkingv1.IPBlock{CIDR: "not-a-cidr"},
					}},
				}},
			},
		},
	)

	if len(state.Warnings) == 0 {
		t.Fatal("expected a warning for the unreadable policy")
	}
	if state.Counts.Policies != 0 {
		t.Errorf("the broken policy must not be counted as understood")
	}
	// The rest of the cluster is still there.
	findWorkload(t, state, "prod", "Deployment", "api")
}

func TestSubscribersReceiveUpdates(t *testing.T) {
	kube := fake.NewClientset(namespace("prod"))
	clients := &cluster.Clients{Kube: kube, Host: "fake"}
	caps := cluster.Capabilities{Policies: []cluster.Capability{{Provider: "k8s", Available: true}}}

	w := cluster.NewWatcher(clients, caps, slog.New(slog.NewTextHandler(io.Discard, nil)))
	w.SetDebounce(10 * time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = w.Run(ctx) }()

	updates, unsubscribe := w.Subscribe()
	defer unsubscribe()

	// Wait for the initial build before making a change, so the update under
	// test is unambiguously the one caused by the create.
	deadline := time.Now().Add(15 * time.Second)
	for w.State() == nil && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if w.State() == nil {
		t.Fatal("no initial state")
	}
	before := w.State().Revision

	// The subscription was created before the initial build, so its buffer
	// already holds that first state. Drain it, or the assertion below reads the
	// publish that predates the change it is meant to observe.
	select {
	case <-updates:
	default:
	}

	if _, err := kube.AppsV1().Deployments("prod").
		Create(ctx, deployment("prod", "new", map[string]string{"app": "new"}), metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}

	timeout := time.After(15 * time.Second)
	for {
		select {
		case s := <-updates:
			if s.Revision <= before {
				continue // a publish that was already in flight
			}
			if _, ok := s.Snapshot.Workload(npeval.ObjectRef{
				Group: "apps", Kind: "Deployment", Namespace: "prod", Name: "new",
			}); !ok {
				t.Errorf("revision %d does not contain the new deployment", s.Revision)
			}
			return
		case <-timeout:
			t.Fatal("no update after a cluster change")
		}
	}
}
