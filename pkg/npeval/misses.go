package npeval

import (
	"fmt"
	"slices"
	"strings"

	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/selection"
)

// MissedRequirement is one clause of a podSelector that a workload's labels
// fail, together with what the workload actually has.
//
// Both halves matter. "This policy wants app=web" is half an answer; "and this
// pod has app=worker" is the other half, and it is the half that tells someone
// whether the fix is a label or a policy.
type MissedRequirement struct {
	// Text is the clause as a human reads it: "app=web", "tier in (edge, dmz)",
	// "!legacy", "role exists".
	Text string `json:"text"`
	// Key is the label the clause is about.
	Key string `json:"key"`
	// Value is what the workload has for Key. Empty when it has no such label,
	// which Present distinguishes from an empty-string value.
	Value   string `json:"value,omitempty"`
	Present bool   `json:"present"`
}

// Miss is a policy that did not select a workload, and the clauses that stopped
// it.
type Miss struct {
	Policy   ObjectRef   `json:"policy"`
	Provider string      `json:"provider"`
	Types    PolicyTypes `json:"types"`
	// Selector is the whole podSelector, rendered: "app=web,tier in (edge)".
	Selector string `json:"selector"`
	// Missed is the subset of clauses the workload fails. Empty only for a
	// selector that matches nothing at all, which has no clauses to fail.
	Missed []MissedRequirement `json:"missed"`
	// Matched is how many clauses the workload does satisfy. A policy failing
	// one clause of three nearly selected this workload; one failing all three
	// was never about it.
	Matched int `json:"matched"`
}

// requirementText renders one clause the way the Kubernetes docs write it.
//
// labels.Requirement.String() is close but renders equality as "app=web" and
// set membership as "tier in (dmz,edge)" without spaces, and it renders Exists
// as a bare key — which reads as a truncated line rather than a condition. The
// difference is small and it is on the one screen whose entire job is being
// legible to somebody who has just been told nothing protects their workload.
func requirementText(r labels.Requirement) string {
	values := r.Values().List()
	switch r.Operator() {
	case selection.Equals, selection.DoubleEquals:
		if len(values) == 1 {
			return fmt.Sprintf("%s=%s", r.Key(), values[0])
		}
	case selection.NotEquals:
		if len(values) == 1 {
			return fmt.Sprintf("%s!=%s", r.Key(), values[0])
		}
	case selection.In:
		return fmt.Sprintf("%s in (%s)", r.Key(), strings.Join(values, ", "))
	case selection.NotIn:
		return fmt.Sprintf("%s not in (%s)", r.Key(), strings.Join(values, ", "))
	case selection.Exists:
		return fmt.Sprintf("%s exists", r.Key())
	case selection.DoesNotExist:
		return fmt.Sprintf("%s does not exist", r.Key())
	}
	return r.String()
}

// Explain reports which clauses of the selector the given labels fail, and how
// many they satisfy.
//
// Requirement matching is delegated to apimachinery rather than reimplemented:
// In, NotIn, Exists and DoesNotExist have enough corners that a second
// implementation would only be a second set of bugs, and this package already
// takes that position for matching itself.
func (s Selector) Explain(l map[string]string) (missed []MissedRequirement, matched int) {
	if s.compiled == nil {
		// A nil selector matches nothing, and has no clauses to point at.
		return nil, 0
	}

	requirements, selectable := s.compiled.Requirements()
	if !selectable {
		return nil, 0
	}

	set := labels.Set(l)
	for _, r := range requirements {
		if r.Matches(set) {
			matched++
			continue
		}
		value, present := l[r.Key()]
		missed = append(missed, MissedRequirement{
			Text:    requirementText(r),
			Key:     r.Key(),
			Value:   value,
			Present: present,
		})
	}
	return missed, matched
}

// ClosestMisses returns the policies in the workload's namespace that do not
// select it, ranked by how nearly they did.
//
// This exists for the screen that says no policy selects a workload. That
// screen states a fact and leaves the obvious next question — "then what was
// supposed to?" — entirely unanswered, and answering it by hand means opening
// every policy in the namespace and comparing selectors by eye. Nearly always
// the answer is one label, and nearly always it is visible the moment the two
// are put side by side.
//
// Only the workload's own namespace is considered, because a NetworkPolicy's
// podSelector cannot reach outside it.
func (e *Evaluator) ClosestMisses(ref ObjectRef) []Miss {
	w, ok := e.snap.Workload(ref)
	if !ok {
		return nil
	}

	selecting := make(map[ObjectRef]bool)
	for _, m := range e.PoliciesFor(ref) {
		selecting[m.Policy] = true
	}

	var out []Miss
	for _, p := range e.snap.Policies(ref.Namespace) {
		if selecting[p.Ref] {
			continue
		}
		missed, matched := p.Selector.Explain(w.Labels)
		out = append(out, Miss{
			Policy:   p.Ref,
			Provider: p.Provider,
			Types:    p.Types,
			Selector: p.Selector.String(),
			Missed:   missed,
			Matched:  matched,
		})
	}

	// Closest first: fewest failed clauses, then most satisfied ones, then a
	// stable name. A policy failing one clause of three is the one worth
	// showing first; a policy that shares nothing with this workload is noise
	// however alphabetically fortunate its name.
	slices.SortStableFunc(out, func(a, b Miss) int {
		if c := len(a.Missed) - len(b.Missed); c != 0 {
			return c
		}
		if c := b.Matched - a.Matched; c != 0 {
			return c
		}
		return a.Policy.Compare(b.Policy)
	})
	return slices.Clip(out)
}
