package cluster_test

import (
	"os"
	"strings"
	"testing"

	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/yaml"

	"github.com/FathiQ/marsad/pkg/cluster"
)

func TestNewFaultClassifies(t *testing.T) {
	gr := schema.GroupResource{Group: "apps", Resource: "deployments"}

	tests := []struct {
		name string
		err  error
		want cluster.FaultKind
	}{
		{"forbidden", apierrors.NewForbidden(gr, "x", os.ErrPermission), cluster.FaultForbidden},
		{"unauthorized", apierrors.NewUnauthorized("bad token"), cluster.FaultUnauthorized},
		{"connection refused", os.ErrClosed, cluster.FaultOther},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := cluster.NewFault(tc.err, "https://example")
			if f == nil {
				t.Fatal("expected a fault")
			}
			if f.Kind != tc.want {
				t.Errorf("Kind = %q, want %q", f.Kind, tc.want)
			}
			// The API server's own words, not a paraphrase: the resource and
			// verb it named are the only things that make an RBAC failure
			// actionable.
			if f.Message != tc.err.Error() {
				t.Errorf("Message = %q, want the error verbatim %q", f.Message, tc.err.Error())
			}
			if f.Host != "https://example" {
				t.Errorf("Host = %q", f.Host)
			}
		})
	}

	if cluster.NewFault(nil, "") != nil {
		t.Error("a nil error is not a fault")
	}
}

func TestForbiddenFaultOffersTheWayOut(t *testing.T) {
	gr := schema.GroupResource{Group: "networking.k8s.io", Resource: "networkpolicies"}
	f := cluster.NewFault(apierrors.NewForbidden(gr, "x", os.ErrPermission), "")

	if !strings.Contains(f.Hint, "get, list and watch") {
		t.Errorf("a permission fault should say what Marsad actually needs: %q", f.Hint)
	}
}

// TestRequiredClusterRoleMatchesTheRepo is the guard that makes offering the
// YAML honest.
//
// The screen that appears when permission is refused hands someone a
// ClusterRole to apply. If that drifts from deploy/rbac.yaml, they apply it,
// it does not work, and the one thing on screen that was supposed to help is
// the thing that wasted their afternoon.
func TestRequiredClusterRoleMatchesTheRepo(t *testing.T) {
	raw, err := os.ReadFile("../../deploy/rbac.yaml")
	if err != nil {
		t.Fatalf("reading deploy/rbac.yaml: %v", err)
	}

	var fromRepo *rbacv1.ClusterRole
	for _, doc := range strings.Split(string(raw), "\n---\n") {
		var meta metav1.TypeMeta
		if err := yaml.Unmarshal([]byte(doc), &meta); err != nil {
			continue
		}
		if meta.Kind != "ClusterRole" {
			continue
		}
		var role rbacv1.ClusterRole
		if err := yaml.UnmarshalStrict([]byte(doc), &role); err != nil {
			t.Fatalf("parsing the ClusterRole from deploy/rbac.yaml: %v", err)
		}
		fromRepo = &role
	}
	if fromRepo == nil {
		t.Fatal("deploy/rbac.yaml has no ClusterRole")
	}

	var generated rbacv1.ClusterRole
	if err := yaml.UnmarshalStrict([]byte(cluster.RequiredClusterRole("marsad")), &generated); err != nil {
		t.Fatalf("parsing the generated ClusterRole: %v", err)
	}

	if len(generated.Rules) != len(fromRepo.Rules) {
		t.Fatalf("generated %d rules, deploy/rbac.yaml has %d", len(generated.Rules), len(fromRepo.Rules))
	}
	for i, want := range fromRepo.Rules {
		got := generated.Rules[i]
		if strings.Join(got.APIGroups, ",") != strings.Join(want.APIGroups, ",") ||
			strings.Join(got.Resources, ",") != strings.Join(want.Resources, ",") ||
			strings.Join(got.Verbs, ",") != strings.Join(want.Verbs, ",") {
			t.Errorf("rule %d differs:\n generated %+v\n repo      %+v", i, got, want)
		}
	}
}

// TestRequiredClusterRoleGrantsReadsOnly: the offered YAML is the second half
// of Marsad's read-only guarantee, and a verb slipping in here would undo it
// as thoroughly as a write path in the code would.
func TestRequiredClusterRoleGrantsReadsOnly(t *testing.T) {
	var role rbacv1.ClusterRole
	if err := yaml.UnmarshalStrict([]byte(cluster.RequiredClusterRole("")), &role); err != nil {
		t.Fatalf("parsing: %v", err)
	}
	if len(role.Rules) == 0 {
		t.Fatal("no rules")
	}
	for _, rule := range role.Rules {
		for _, verb := range rule.Verbs {
			switch verb {
			case "get", "list", "watch":
			default:
				t.Errorf("rule %v grants %q, which is not a read", rule.Resources, verb)
			}
		}
	}
	if role.Name != "marsad" {
		t.Errorf("an unnamed role should default to marsad, got %q", role.Name)
	}
}
