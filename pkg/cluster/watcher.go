package cluster

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/tools/cache"

	awsv1alpha1 "github.com/FathiQ/marsad/pkg/apis/awsanp/v1alpha1"
	"github.com/FathiQ/marsad/pkg/npeval"
	"github.com/FathiQ/marsad/pkg/npeval/provider/awsanp"
	"github.com/FathiQ/marsad/pkg/npeval/provider/k8s"
)

const (
	// resyncPeriod is a safety net for missed watch events, not the update
	// mechanism: informers deliver changes as they happen.
	resyncPeriod = 10 * time.Minute

	defaultDebounce = 500 * time.Millisecond
	// maxDebounce bounds how long a continuously churning cluster can postpone
	// a rebuild. Without it, a cluster with constant pod turnover would debounce
	// forever and the graph would never update.
	maxDebounce = 5 * time.Second
)

// Warning records something Marsad could not interpret. A single malformed
// policy must not blank the whole graph, so these are collected and surfaced
// rather than raised.
type Warning struct {
	Object  string `json:"object"`
	Message string `json:"message"`
}

// State is one immutable evaluation of the cluster.
type State struct {
	Snapshot     *npeval.Snapshot `json:"-"`
	Revision     uint64           `json:"revision"`
	BuiltAt      time.Time        `json:"builtAt"`
	Capabilities Capabilities     `json:"capabilities"`
	Warnings     []Warning        `json:"warnings,omitempty"`

	Counts struct {
		Namespaces int `json:"namespaces"`
		Workloads  int `json:"workloads"`
		Policies   int `json:"policies"`
	} `json:"counts"`
}

// Watcher keeps an up-to-date State from cluster informers.
//
// The published State is immutable and swapped atomically, so readers never
// lock and never see a half-built graph.
type Watcher struct {
	clients *Clients
	caps    Capabilities
	log     *slog.Logger

	debounce time.Duration

	factory    informers.SharedInformerFactory
	dynFactory dynamicinformer.DynamicSharedInformerFactory
	anpLister  cache.GenericLister

	// Retained so startup can be reported rather than guessed at. Waiting for
	// caches to sync is the slowest thing Marsad does on a large cluster, and a
	// spinner that says nothing for forty seconds is indistinguishable from one
	// that is stuck.
	progress []syncGroup

	dirty chan struct{}
	state atomic.Pointer[State]
	rev   atomic.Uint64

	mu     sync.Mutex
	subs   map[int]chan *State
	nextID int
}

// NewWatcher wires informers for everything policy evaluation needs.
func NewWatcher(clients *Clients, caps Capabilities, log *slog.Logger) *Watcher {
	if log == nil {
		log = slog.Default()
	}

	w := &Watcher{
		clients:  clients,
		caps:     caps,
		log:      log,
		debounce: defaultDebounce,
		factory:  informers.NewSharedInformerFactory(clients.Kube, resyncPeriod),
		// Buffered by one: the rebuild loop only needs to know that something
		// changed, not how many times.
		dirty: make(chan struct{}, 1),
		subs:  map[int]chan *State{},
	}

	f := w.factory

	// Grouped the way the startup screen reads them, not the way client-go
	// organises them: nobody waiting for Marsad to start is asking after
	// ReplicaSets.
	namespaces := []cache.SharedIndexInformer{f.Core().V1().Namespaces().Informer()}
	workloads := []cache.SharedIndexInformer{
		f.Apps().V1().Deployments().Informer(),
		f.Apps().V1().StatefulSets().Informer(),
		f.Apps().V1().DaemonSets().Informer(),
		f.Batch().V1().Jobs().Informer(),
		f.Batch().V1().CronJobs().Informer(),
	}
	// Watched, but not counted towards anything a person asked about: Pods are
	// how orphans are found, and ReplicaSets only exist to walk
	// Pod → ReplicaSet → Deployment.
	plumbing := []cache.SharedIndexInformer{
		f.Core().V1().Pods().Informer(),
		f.Apps().V1().ReplicaSets().Informer(),
	}
	policies := []cache.SharedIndexInformer{f.Networking().V1().NetworkPolicies().Informer()}

	if caps.Has(awsanp.Name) {
		w.dynFactory = dynamicinformer.NewFilteredDynamicSharedInformerFactory(
			clients.Dynamic, resyncPeriod, metav1.NamespaceAll, nil)
		gvr := awsanp.Provider{}.GVR()
		anp := w.dynFactory.ForResource(gvr)
		w.anpLister = anp.Lister()
		policies = append(policies, anp.Informer())
	}

	w.progress = []syncGroup{
		{name: "namespaces", informers: namespaces},
		{name: "workloads", informers: workloads},
		{name: "network policies", informers: policies},
	}

	for _, group := range append(w.progress, syncGroup{informers: plumbing}) {
		for _, inf := range group.informers {
			w.addHandler(inf)
		}
	}

	return w
}

// syncGroup is one line on the startup screen.
type syncGroup struct {
	name      string
	informers []cache.SharedIndexInformer
}

// SyncStep reports one group's readiness while the caches fill.
type SyncStep struct {
	Name   string `json:"name"`
	Synced bool   `json:"synced"`
	// Count is what has arrived so far, which before Synced is a lower bound
	// rather than a total. The UI says "so far" for exactly that reason.
	Count int `json:"count"`
}

// Progress reports how far the initial cache sync has got.
//
// Available before the first State exists, which is the whole point: every
// other endpoint answers 503 until the caches are warm, and that is precisely
// the window someone is staring at a blank screen wondering whether it works.
func (w *Watcher) Progress() []SyncStep {
	out := make([]SyncStep, 0, len(w.progress))
	for _, group := range w.progress {
		step := SyncStep{Name: group.name, Synced: true}
		for _, inf := range group.informers {
			if !inf.HasSynced() {
				step.Synced = false
			}
			step.Count += len(inf.GetStore().ListKeys())
		}
		out = append(out, step)
	}
	return out
}

// SetDebounce overrides the rebuild delay. Intended for tests.
func (w *Watcher) SetDebounce(d time.Duration) { w.debounce = d }

func (w *Watcher) addHandler(inf cache.SharedIndexInformer) {
	handler := cache.ResourceEventHandlerFuncs{
		AddFunc:    func(any) { w.markDirty() },
		DeleteFunc: func(any) { w.markDirty() },
		UpdateFunc: func(old, new any) {
			// Pod status churns constantly on a busy cluster. Only a change in
			// resourceVersion means something actually happened, and even then
			// the debounce collapses bursts.
			oldMeta, err1 := meta.Accessor(old)
			newMeta, err2 := meta.Accessor(new)
			if err1 == nil && err2 == nil && oldMeta.GetResourceVersion() == newMeta.GetResourceVersion() {
				return
			}
			w.markDirty()
		},
	}
	if _, err := inf.AddEventHandler(handler); err != nil {
		w.log.Error("add informer event handler", "error", err)
	}
}

func (w *Watcher) markDirty() {
	select {
	case w.dirty <- struct{}{}:
	default: // already flagged; the rebuild will pick up everything at once
	}
}

// Run starts the informers, waits for the initial sync, publishes a first State,
// then rebuilds on change until the context is cancelled.
func (w *Watcher) Run(ctx context.Context) error {
	w.factory.Start(ctx.Done())
	if w.dynFactory != nil {
		w.dynFactory.Start(ctx.Done())
	}

	w.log.Info("waiting for informer cache sync")
	for gvr, synced := range w.factory.WaitForCacheSync(ctx.Done()) {
		if !synced {
			return fmt.Errorf("cache sync failed for %s", gvr)
		}
	}
	if w.dynFactory != nil {
		for gvr, synced := range w.dynFactory.WaitForCacheSync(ctx.Done()) {
			if !synced {
				return fmt.Errorf("cache sync failed for %s", gvr)
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	w.rebuild()
	w.log.Info("initial graph built",
		"workloads", w.State().Counts.Workloads,
		"policies", w.State().Counts.Policies)

	return w.loop(ctx)
}

// loop coalesces change events. A quiet period of `debounce` publishes, and
// maxDebounce caps how long a continuously changing cluster can defer one.
func (w *Watcher) loop(ctx context.Context) error {
	var (
		timer    *time.Timer
		timeout  <-chan time.Time
		deadline time.Time
	)
	stop := func() {
		if timer != nil {
			timer.Stop()
			timer = nil
			timeout = nil
		}
	}
	defer stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()

		case <-w.dirty:
			now := time.Now()
			if timer == nil {
				deadline = now.Add(maxDebounce)
				timer = time.NewTimer(w.debounce)
				timeout = timer.C
				continue
			}
			wait := w.debounce
			if remaining := time.Until(deadline); remaining < wait {
				wait = remaining
			}
			if wait < 0 {
				wait = 0
			}
			timer.Stop()
			timer.Reset(wait)

		case <-timeout:
			stop()
			w.rebuild()
		}
	}
}

// State returns the current evaluation, or nil before the first build.
func (w *Watcher) State() *State { return w.state.Load() }

// Subscribe returns a channel receiving each new State, and a function to stop.
//
// The channel is buffered and lossy on purpose: a slow client should fall behind
// to the latest state rather than block the rebuild loop or accumulate a backlog
// of stale graphs it no longer cares about.
func (w *Watcher) Subscribe() (<-chan *State, func()) {
	ch := make(chan *State, 1)

	w.mu.Lock()
	id := w.nextID
	w.nextID++
	w.subs[id] = ch
	w.mu.Unlock()

	return ch, func() {
		w.mu.Lock()
		if c, ok := w.subs[id]; ok {
			delete(w.subs, id)
			close(c)
		}
		w.mu.Unlock()
	}
}

func (w *Watcher) publish(s *State) {
	w.state.Store(s)

	w.mu.Lock()
	defer w.mu.Unlock()
	for _, ch := range w.subs {
		select {
		case ch <- s:
		default:
			// Drop the older pending state in favour of this one; a client that
			// is behind wants the newest graph, not the one before it.
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- s:
			default:
			}
		}
	}
}

// rebuild reconstructs the snapshot from the informer caches.
//
// This is a full rebuild rather than an incremental update of the previous one.
// It reads only from in-memory listers — no API calls — and indexing a few
// thousand objects takes single-digit milliseconds, so the complexity and the
// whole class of stale-index bugs that an incremental evaluator would introduce
// buy nothing. Incrementality lives where it is actually visible: the WebSocket
// stream diffs successive graphs and sends only what changed.
func (w *Watcher) rebuild() {
	start := time.Now()
	state := &State{
		Revision:     w.rev.Add(1),
		BuiltAt:      start,
		Capabilities: w.caps,
	}

	b := npeval.NewBuilder()
	warn := func(object string, err error) {
		state.Warnings = append(state.Warnings, Warning{Object: object, Message: err.Error()})
	}

	namespaces, err := w.factory.Core().V1().Namespaces().Lister().List(labels.Everything())
	if err != nil {
		warn("namespaces", err)
	}
	for _, ns := range namespaces {
		b.AddNamespace(npeval.Namespace{Name: ns.Name, Labels: ns.Labels})
	}
	state.Counts.Namespaces = len(namespaces)

	workloads := w.collectWorkloads(warn)
	for _, wl := range workloads {
		b.AddWorkload(wl)
	}
	state.Counts.Workloads = len(workloads)

	state.Counts.Policies = w.collectPolicies(b, warn)

	snap, err := b.Build()
	if err != nil {
		// Building can only fail on duplicate or malformed refs, which means the
		// previous state is more trustworthy than anything we could publish.
		w.log.Error("snapshot build failed; keeping the previous graph", "error", err)
		return
	}
	state.Snapshot = snap

	w.publish(state)
	w.log.Debug("graph rebuilt",
		"revision", state.Revision,
		"workloads", state.Counts.Workloads,
		"policies", state.Counts.Policies,
		"warnings", len(state.Warnings),
		"took", time.Since(start))
}

// collectWorkloads turns controllers and pods into graph nodes.
//
// Pods are attributed to their controlling owner so a Deployment is one node
// rather than N. A pod whose owner Marsad does not know — an Argo Rollout, a
// custom operator's CRD — is attributed to that owner as a synthetic node
// instead of being dropped, because an invisible workload is the one most likely
// to be unprotected.
func (w *Watcher) collectWorkloads(warn func(string, error)) []npeval.Workload {
	byRef := map[npeval.ObjectRef]npeval.Workload{}
	add := func(wl npeval.Workload) {
		if wl.Labels == nil {
			wl.Labels = map[string]string{}
		}
		byRef[wl.Ref] = wl
	}

	f := w.factory
	if items, err := f.Apps().V1().Deployments().Lister().List(labels.Everything()); err != nil {
		warn("deployments", err)
	} else {
		for _, d := range items {
			add(workloadFromDeployment(d))
		}
	}
	if items, err := f.Apps().V1().StatefulSets().Lister().List(labels.Everything()); err != nil {
		warn("statefulsets", err)
	} else {
		for _, s := range items {
			add(workloadFromStatefulSet(s))
		}
	}
	if items, err := f.Apps().V1().DaemonSets().Lister().List(labels.Everything()); err != nil {
		warn("daemonsets", err)
	} else {
		for _, d := range items {
			add(workloadFromDaemonSet(d))
		}
	}
	if items, err := f.Batch().V1().CronJobs().Lister().List(labels.Everything()); err != nil {
		warn("cronjobs", err)
	} else {
		for _, c := range items {
			add(workloadFromCronJob(c))
		}
	}

	// A Job owned by a CronJob is represented by the CronJob; a standalone Job
	// is its own node.
	jobs, err := f.Batch().V1().Jobs().Lister().List(labels.Everything())
	if err != nil {
		warn("jobs", err)
	}
	jobOwners := map[string]*metav1.OwnerReference{}
	for _, j := range jobs {
		owner := ownerRef(j)
		jobOwners[j.Namespace+"/"+j.Name] = owner
		if owner == nil {
			add(workloadFromJob(j))
		}
	}

	replicaSets, err := f.Apps().V1().ReplicaSets().Lister().List(labels.Everything())
	if err != nil {
		warn("replicasets", err)
	}
	rsOwners := map[string]*metav1.OwnerReference{}
	for _, rs := range replicaSets {
		rsOwners[rs.Namespace+"/"+rs.Name] = ownerRef(rs)
	}

	pods, err := f.Core().V1().Pods().Lister().List(labels.Everything())
	if err != nil {
		warn("pods", err)
	}

	live := map[npeval.ObjectRef]int{}
	for _, p := range pods {
		if p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed {
			continue
		}
		root := rootRef(p, rsOwners, jobOwners)
		live[root]++
		if _, known := byRef[root]; !known {
			// Either a bare pod or a pod under a controller kind Marsad does not
			// watch. Either way it needs a node, built from the pod's own labels
			// since there is no template to read.
			synthetic := workloadFromPod(p)
			synthetic.Ref = root
			if root.Kind != "Pod" {
				synthetic.Kind = npeval.WorkloadKind(root.Kind)
			}
			add(synthetic)
		}
	}

	out := make([]npeval.Workload, 0, len(byRef))
	for ref, wl := range byRef {
		// Prefer the observed pod count over the controller's status: it is what
		// the replica badge should show, and it is what actually exists.
		if n, ok := live[ref]; ok {
			wl.Replicas = n
		}
		out = append(out, wl)
	}
	return out
}

// rootRef walks a pod's controller chain to the object that should own its node.
func rootRef(p *corev1.Pod, rsOwners, jobOwners map[string]*metav1.OwnerReference) npeval.ObjectRef {
	owner := ownerRef(p)
	if owner == nil {
		return npeval.ObjectRef{Kind: "Pod", Namespace: p.Namespace, Name: p.Name}
	}

	key := p.Namespace + "/" + owner.Name
	switch owner.Kind {
	case "ReplicaSet":
		if parent := rsOwners[key]; parent != nil {
			return refFromOwner(parent, p.Namespace)
		}
	case "Job":
		if parent := jobOwners[key]; parent != nil {
			return refFromOwner(parent, p.Namespace)
		}
	}
	return refFromOwner(owner, p.Namespace)
}

func refFromOwner(owner *metav1.OwnerReference, namespace string) npeval.ObjectRef {
	gv, err := schema.ParseGroupVersion(owner.APIVersion)
	if err != nil {
		gv = schema.GroupVersion{}
	}
	return npeval.ObjectRef{Group: gv.Group, Kind: owner.Kind, Namespace: namespace, Name: owner.Name}
}

// collectPolicies normalizes every policy from every available provider.
func (w *Watcher) collectPolicies(b *npeval.Builder, warn func(string, error)) int {
	var count int

	netpols, err := w.factory.Networking().V1().NetworkPolicies().Lister().List(labels.Everything())
	if err != nil {
		warn("networkpolicies", err)
	}
	for _, np := range netpols {
		p, err := k8s.NormalizePolicy(np)
		if err != nil {
			warn(fmt.Sprintf("NetworkPolicy %s/%s", np.Namespace, np.Name), err)
			continue
		}
		b.AddPolicy(p)
		count++
	}

	if w.anpLister == nil {
		return count
	}
	objs, err := w.anpLister.List(labels.Everything())
	if err != nil {
		warn("applicationnetworkpolicies", err)
		return count
	}
	for _, obj := range objs {
		anp, err := decodeANP(obj)
		if err != nil {
			warn("ApplicationNetworkPolicy", err)
			continue
		}
		p, err := awsanp.NormalizePolicy(anp)
		if err != nil {
			warn(fmt.Sprintf("ApplicationNetworkPolicy %s/%s", anp.Namespace, anp.Name), err)
			continue
		}
		b.AddPolicy(p)
		count++
	}
	return count
}

func decodeANP(obj runtime.Object) (*awsv1alpha1.ApplicationNetworkPolicy, error) {
	u, ok := obj.(interface{ UnstructuredContent() map[string]any })
	if !ok {
		return nil, fmt.Errorf("expected an unstructured object, got %T", obj)
	}
	var anp awsv1alpha1.ApplicationNetworkPolicy
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(u.UnstructuredContent(), &anp); err != nil {
		return nil, fmt.Errorf("decode ApplicationNetworkPolicy: %w", err)
	}
	return &anp, nil
}
