package npeval

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
)

// Selector is a compiled label selector.
//
// It wraps metav1.LabelSelector rather than reimplementing matchExpressions:
// operator semantics (In, NotIn, Exists, DoesNotExist) have enough corners that
// a second implementation would only be a second set of bugs.
type Selector struct {
	raw      metav1.LabelSelector
	compiled labels.Selector
}

// NewSelector compiles a label selector.
//
// A nil selector matches nothing, an empty one matches everything — the same
// convention apimachinery uses. Callers for whom "omitted" carries a contextual
// meaning (a peer's namespaceSelector means "the policy's own namespace") must
// keep the pointer and decide before calling.
func NewSelector(ls *metav1.LabelSelector) (Selector, error) {
	compiled, err := metav1.LabelSelectorAsSelector(ls)
	if err != nil {
		return Selector{}, err
	}
	s := Selector{compiled: compiled}
	if ls != nil {
		s.raw = *ls.DeepCopy()
	}
	return s, nil
}

// MustSelector is NewSelector for tests and static selectors.
func MustSelector(ls *metav1.LabelSelector) Selector {
	s, err := NewSelector(ls)
	if err != nil {
		panic(err)
	}
	return s
}

// EverythingSelector matches every set of labels.
func EverythingSelector() Selector {
	return MustSelector(&metav1.LabelSelector{})
}

// Matches reports whether the given labels satisfy the selector.
func (s Selector) Matches(l map[string]string) bool {
	if s.compiled == nil {
		return false
	}
	return s.compiled.Matches(labels.Set(l))
}

// MatchesEverything reports whether the selector is unconstrained, i.e. `{}`.
// This drives the MEDIUM "allows an entire namespace" finding.
func (s Selector) MatchesEverything() bool {
	return s.compiled != nil && s.compiled.Empty()
}

// Empty reports whether the selector matches nothing at all (a nil selector).
func (s Selector) Empty() bool { return s.compiled == nil }

// Raw returns the underlying selector, for display and re-serialization.
func (s Selector) Raw() metav1.LabelSelector { return s.raw }

// String renders the selector for UI labels: "app=api,tier in (web,edge)", or
// "*" when it matches everything.
func (s Selector) String() string {
	if s.compiled == nil {
		return "<none>"
	}
	if s.compiled.Empty() {
		return "*"
	}
	return s.compiled.String()
}
