package npeval

import (
	"fmt"
	"slices"
)

// Snapshot is an immutable view of everything needed to evaluate policy.
//
// Because it never changes after Build, an Evaluator over it needs no locking
// and is safe for concurrent use. The watch layer builds a fresh snapshot on
// change and swaps the pointer.
type Snapshot struct {
	namespaces []Namespace
	nsByName   map[string]Namespace

	workloads []Workload
	wlByRef   map[ObjectRef]Workload
	wlByNS    map[string][]Workload

	policies []Policy
	polByRef map[ObjectRef]Policy

	// Precomputed during Build so queries never rescan.
	selects    map[ObjectRef][]ObjectRef // policy → workloads it selects
	selectedBy map[ObjectRef][]ObjectRef // workload → policies selecting it

	providers []string
}

// Builder accumulates objects for a Snapshot. It is not safe for concurrent use;
// build on one goroutine, then share the result freely.
type Builder struct {
	namespaces []Namespace
	workloads  []Workload
	policies   []Policy
}

// NewBuilder returns an empty Builder.
func NewBuilder() *Builder { return &Builder{} }

// AddNamespace records a namespace and the labels a namespaceSelector matches.
func (b *Builder) AddNamespace(ns Namespace) *Builder {
	b.namespaces = append(b.namespaces, ns)
	return b
}

// AddWorkload records a workload and its pod-template labels.
func (b *Builder) AddWorkload(w Workload) *Builder {
	b.workloads = append(b.workloads, w)
	return b
}

// AddPolicy records an already-normalized policy from any provider.
func (b *Builder) AddPolicy(p Policy) *Builder {
	b.policies = append(b.policies, p)
	return b
}

// Build indexes the accumulated objects and resolves policy selection once, so
// that later queries are map lookups rather than repeated label matching.
func (b *Builder) Build() (*Snapshot, error) {
	s := &Snapshot{
		nsByName:   make(map[string]Namespace, len(b.namespaces)),
		wlByRef:    make(map[ObjectRef]Workload, len(b.workloads)),
		wlByNS:     make(map[string][]Workload),
		polByRef:   make(map[ObjectRef]Policy, len(b.policies)),
		selects:    make(map[ObjectRef][]ObjectRef, len(b.policies)),
		selectedBy: make(map[ObjectRef][]ObjectRef, len(b.workloads)),
	}

	for _, ns := range b.namespaces {
		if ns.Name == "" {
			return nil, fmt.Errorf("namespace with empty name")
		}
		if _, dup := s.nsByName[ns.Name]; dup {
			return nil, fmt.Errorf("duplicate namespace %q", ns.Name)
		}
		s.nsByName[ns.Name] = ns
		s.namespaces = append(s.namespaces, ns)
	}

	for _, w := range b.workloads {
		if w.Ref.Namespace == "" || w.Ref.Name == "" {
			return nil, fmt.Errorf("workload %s: namespace and name are required", w.Ref)
		}
		if _, dup := s.wlByRef[w.Ref]; dup {
			return nil, fmt.Errorf("duplicate workload %s", w.Ref)
		}
		s.wlByRef[w.Ref] = w
		s.workloads = append(s.workloads, w)
		s.wlByNS[w.Ref.Namespace] = append(s.wlByNS[w.Ref.Namespace], w)
	}

	seenProvider := map[string]bool{}
	for _, p := range b.policies {
		if p.Ref.Namespace == "" || p.Ref.Name == "" {
			return nil, fmt.Errorf("policy %s: namespace and name are required", p.Ref)
		}
		if _, dup := s.polByRef[p.Ref]; dup {
			return nil, fmt.Errorf("duplicate policy %s", p.Ref)
		}
		s.polByRef[p.Ref] = p
		s.policies = append(s.policies, p)
		if !seenProvider[p.Provider] {
			seenProvider[p.Provider] = true
			s.providers = append(s.providers, p.Provider)
		}

		// Policies are namespaced and select only within their own namespace.
		for _, w := range s.wlByNS[p.Ref.Namespace] {
			if p.Selector.Matches(w.Labels) {
				s.selects[p.Ref] = append(s.selects[p.Ref], w.Ref)
				s.selectedBy[w.Ref] = append(s.selectedBy[w.Ref], p.Ref)
			}
		}
	}

	sortRefs := func(m map[ObjectRef][]ObjectRef) {
		for k := range m {
			slices.SortFunc(m[k], ObjectRef.Compare)
		}
	}
	sortRefs(s.selects)
	sortRefs(s.selectedBy)

	slices.SortFunc(s.namespaces, func(a, b Namespace) int { return cmpString(a.Name, b.Name) })
	slices.SortFunc(s.workloads, func(a, b Workload) int { return a.Ref.Compare(b.Ref) })
	slices.SortFunc(s.policies, func(a, b Policy) int { return a.Ref.Compare(b.Ref) })
	slices.Sort(s.providers)
	for ns := range s.wlByNS {
		slices.SortFunc(s.wlByNS[ns], func(a, b Workload) int { return a.Ref.Compare(b.Ref) })
	}

	return s, nil
}

// MustBuild is Build for tests and static fixtures.
func (b *Builder) MustBuild() *Snapshot {
	s, err := b.Build()
	if err != nil {
		panic(err)
	}
	return s
}

// Namespaces returns every namespace, sorted by name.
func (s *Snapshot) Namespaces() []Namespace { return slices.Clone(s.namespaces) }

// Namespace looks up one namespace.
func (s *Snapshot) Namespace(name string) (Namespace, bool) {
	ns, ok := s.nsByName[name]
	return ns, ok
}

// Workloads returns the workloads in a namespace, or all of them when namespace
// is empty. Sorted.
func (s *Snapshot) Workloads(namespace string) []Workload {
	if namespace == "" {
		return slices.Clone(s.workloads)
	}
	return slices.Clone(s.wlByNS[namespace])
}

// Workload looks up one workload.
func (s *Snapshot) Workload(ref ObjectRef) (Workload, bool) {
	w, ok := s.wlByRef[ref]
	return w, ok
}

// Policies returns the policies in a namespace, or all of them when namespace is
// empty. Sorted.
func (s *Snapshot) Policies(namespace string) []Policy {
	if namespace == "" {
		return slices.Clone(s.policies)
	}
	var out []Policy
	for _, p := range s.policies {
		if p.Ref.Namespace == namespace {
			out = append(out, p)
		}
	}
	return out
}

// Policy looks up one policy.
func (s *Snapshot) Policy(ref ObjectRef) (Policy, bool) {
	p, ok := s.polByRef[ref]
	return p, ok
}

// Providers returns the distinct provider names contributing policies, sorted.
func (s *Snapshot) Providers() []string { return slices.Clone(s.providers) }

// matchingNamespaces returns the namespaces a peer's namespaceSelector selects.
// A nil selector means the policy's own namespace, per the API.
func (s *Snapshot) matchingNamespaces(sel *Selector, policyNamespace string) []string {
	if sel == nil {
		if _, ok := s.nsByName[policyNamespace]; ok {
			return []string{policyNamespace}
		}
		// Evaluate against the policy's namespace even if the caller never added
		// a Namespace object for it; policies cannot exist outside one.
		return []string{policyNamespace}
	}
	var out []string
	for _, ns := range s.namespaces {
		if sel.Matches(ns.Labels) {
			out = append(out, ns.Name)
		}
	}
	return out
}

func cmpString(a, b string) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	default:
		return 0
	}
}
