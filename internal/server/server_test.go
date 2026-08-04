package server_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"

	"github.com/FathiQ/marsad/internal/server"
	"github.com/FathiQ/marsad/pkg/cluster"
	"github.com/FathiQ/marsad/pkg/npeval"
	"github.com/FathiQ/marsad/pkg/npeval/provider/k8s"
)

// fixedSource stands in for the watcher so the handlers can be exercised
// against a known snapshot with no cluster and no informers.
type fixedSource struct{ state *cluster.State }

func (f *fixedSource) State() *cluster.State { return f.state }

func (f *fixedSource) Subscribe() (<-chan *cluster.State, func()) {
	ch := make(chan *cluster.State, 1)
	return ch, func() { close(ch) }
}

func port(n int32) *intstr.IntOrString { v := intstr.FromInt32(n); return &v }

func sel(kv ...string) *metav1.LabelSelector {
	m := map[string]string{}
	for i := 0; i < len(kv); i += 2 {
		m[kv[i]] = kv[i+1]
	}
	return &metav1.LabelSelector{MatchLabels: m}
}

func deploy(ns, name string, kv ...string) npeval.Workload {
	m := map[string]string{}
	for i := 0; i < len(kv); i += 2 {
		m[kv[i]] = kv[i+1]
	}
	return npeval.Workload{
		Ref:      npeval.ObjectRef{Group: "apps", Kind: "Deployment", Namespace: ns, Name: name},
		Kind:     npeval.KindDeployment,
		Labels:   m,
		Replicas: 2,
	}
}

func testServer(t *testing.T) *server.Server {
	t.Helper()

	np := &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Namespace: "prod", Name: "db-ingress"},
		Spec: networkingv1.NetworkPolicySpec{
			PodSelector: *sel("app", "db"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			Ingress: []networkingv1.NetworkPolicyIngressRule{{
				From:  []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "api")}},
				Ports: []networkingv1.NetworkPolicyPort{{Port: port(5432)}},
			}},
		},
	}
	policy, err := k8s.NormalizePolicy(np)
	if err != nil {
		t.Fatal(err)
	}

	snap, err := npeval.NewBuilder().
		AddNamespace(npeval.Namespace{Name: "prod"}).
		AddWorkload(deploy("prod", "api", "app", "api")).
		AddWorkload(deploy("prod", "db", "app", "db")).
		AddPolicy(policy).
		Build()
	if err != nil {
		t.Fatal(err)
	}

	state := &cluster.State{Snapshot: snap, Revision: 7, BuiltAt: time.Now()}
	state.Counts.Namespaces = 1
	state.Counts.Workloads = 2
	state.Counts.Policies = 1

	return server.New(server.Options{Source: &fixedSource{state: state}})
}

func do(t *testing.T, s *server.Server, method, target, body string) (*http.Response, []byte) {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, target, nil)
	} else {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	res := w.Result()
	t.Cleanup(func() { _ = res.Body.Close() })
	return res, w.Body.Bytes()
}

func TestMetaReportsStateAndReadOnly(t *testing.T) {
	res, body := do(t, testServer(t), http.MethodGet, "/api/meta", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", res.StatusCode, body)
	}
	var meta map[string]any
	if err := json.Unmarshal(body, &meta); err != nil {
		t.Fatal(err)
	}
	if meta["revision"] != float64(7) {
		t.Errorf("revision = %v", meta["revision"])
	}
	if meta["readOnly"] != true {
		t.Error("meta must advertise that Marsad is read-only")
	}
	if meta["combineMode"] != "intersect" {
		t.Errorf("combineMode = %v, want the conservative default", meta["combineMode"])
	}
}

func TestGraphEndpoint(t *testing.T) {
	s := testServer(t)

	t.Run("defaults to namespace level", func(t *testing.T) {
		res, body := do(t, s, http.MethodGet, "/api/graph", "")
		if res.StatusCode != http.StatusOK {
			t.Fatalf("status %d: %s", res.StatusCode, body)
		}
		var out struct {
			Graph struct {
				Level string `json:"level"`
				Nodes []struct {
					ID string `json:"id"`
				} `json:"nodes"`
			} `json:"graph"`
		}
		if err := json.Unmarshal(body, &out); err != nil {
			t.Fatal(err)
		}
		if out.Graph.Level != "namespace" {
			t.Errorf("level = %q", out.Graph.Level)
		}
		if len(out.Graph.Nodes) == 0 {
			t.Error("expected nodes")
		}
	})

	t.Run("rejects an unknown level", func(t *testing.T) {
		res, body := do(t, s, http.MethodGet, "/api/graph?level=pod", "")
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("status %d: %s", res.StatusCode, body)
		}
		if !strings.Contains(string(body), "namespace or workload") {
			t.Errorf("the error should say what is valid: %s", body)
		}
	})
}

func TestWorkloadDetailIncludesPolicyYAML(t *testing.T) {
	res, body := do(t, testServer(t), http.MethodGet, "/api/workloads/prod/db", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", res.StatusCode, body)
	}

	var detail struct {
		Isolation npeval.Isolation `json:"isolation"`
		Policies  []struct {
			YAML string `json:"yaml"`
			Ref  struct {
				Name string `json:"name"`
			} `json:"ref"`
		} `json:"policies"`
		Ingress struct {
			Isolated bool `json:"isolated"`
			Allows   []struct {
				Via []string `json:"via"`
			} `json:"allows"`
		} `json:"ingress"`
	}
	if err := json.Unmarshal(body, &detail); err != nil {
		t.Fatal(err)
	}

	if !detail.Isolation.Ingress {
		t.Error("db should be ingress-isolated")
	}
	if len(detail.Policies) != 1 || detail.Policies[0].Ref.Name != "db-ingress" {
		t.Fatalf("got policies %+v", detail.Policies)
	}
	// The drawer's read-only YAML viewer renders this; without it the
	// traceability story stops at the policy name.
	if !strings.Contains(detail.Policies[0].YAML, "podSelector") {
		t.Errorf("policy YAML looks wrong: %q", detail.Policies[0].YAML)
	}
	if len(detail.Ingress.Allows) == 0 || len(detail.Ingress.Allows[0].Via) == 0 {
		t.Error("effective rules must cite the rules that produced them")
	}
}

func TestWorkloadNotFound(t *testing.T) {
	res, _ := do(t, testServer(t), http.MethodGet, "/api/workloads/prod/nope", "")
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("status %d, want 404", res.StatusCode)
	}
}

func TestSimulateEndpoint(t *testing.T) {
	s := testServer(t)

	t.Run("allowed both ways", func(t *testing.T) {
		res, body := do(t, s, http.MethodPost, "/api/simulate", `{
			"from": {"namespace": "prod", "name": "api"},
			"to":   {"namespace": "prod", "name": "db"},
			"protocol": "tcp", "port": 5432
		}`)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("status %d: %s", res.StatusCode, body)
		}
		var v npeval.Verdict
		if err := json.Unmarshal(body, &v); err != nil {
			t.Fatal(err)
		}
		if !v.Allowed {
			t.Errorf("got %s", v.Summary)
		}
		if len(v.Ingress.Via) == 0 {
			t.Error("an allowed verdict must name the rule that allowed it")
		}
	})

	t.Run("denied on the wrong port", func(t *testing.T) {
		res, body := do(t, s, http.MethodPost, "/api/simulate", `{
			"from": {"namespace": "prod", "name": "api"},
			"to":   {"namespace": "prod", "name": "db"},
			"port": 6379
		}`)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("status %d: %s", res.StatusCode, body)
		}
		var v npeval.Verdict
		if err := json.Unmarshal(body, &v); err != nil {
			t.Fatal(err)
		}
		if v.Allowed {
			t.Errorf("got %s, want denied", v.Summary)
		}
	})

	t.Run("a bare IP is accepted as well as a prefix", func(t *testing.T) {
		res, body := do(t, s, http.MethodPost, "/api/simulate", `{
			"from": {"namespace": "prod", "name": "api"},
			"to":   {"cidr": "8.8.8.8"},
			"port": 443
		}`)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("status %d: %s", res.StatusCode, body)
		}
	})

	t.Run("an unknown workload is a clear error", func(t *testing.T) {
		res, body := do(t, s, http.MethodPost, "/api/simulate", `{
			"from": {"namespace": "prod", "name": "ghost"},
			"to":   {"namespace": "prod", "name": "db"},
			"port": 5432
		}`)
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("status %d: %s", res.StatusCode, body)
		}
		if !strings.Contains(string(body), "ghost") {
			t.Errorf("the error should name what was not found: %s", body)
		}
	})
}

// Marsad never writes. Anything that is not a read is refused before it reaches
// a handler, so a future mistake cannot quietly introduce one.
func TestWriteMethodsAreRefused(t *testing.T) {
	s := testServer(t)
	for _, method := range []string{http.MethodPut, http.MethodPatch, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			res, body := do(t, s, method, "/api/graph", "")
			if res.StatusCode != http.StatusMethodNotAllowed {
				t.Fatalf("status %d, want 405", res.StatusCode)
			}
			if !strings.Contains(string(body), "read-only") {
				t.Errorf("body should say why: %s", body)
			}
		})
	}
}

// Before the informers sync there is no state. That is a normal, brief condition
// and the client is told to retry rather than shown an error.
func TestNotReadyIsRetryable(t *testing.T) {
	s := server.New(server.Options{Source: &fixedSource{}})
	res, body := do(t, s, http.MethodGet, "/api/graph", "")
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503", res.StatusCode)
	}
	if !strings.Contains(string(body), "retry") {
		t.Errorf("body should mark the condition retryable: %s", body)
	}
}

func TestFrontendIsServed(t *testing.T) {
	res, body := do(t, testServer(t), http.MethodGet, "/", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	if !strings.Contains(string(body), "Marsad") {
		t.Error("expected the embedded UI")
	}
}

func TestNamespacesEndpoint(t *testing.T) {
	res, body := do(t, testServer(t), http.MethodGet, "/api/namespaces", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", res.StatusCode, body)
	}
	var out []struct {
		Name        string `json:"name"`
		Workloads   int    `json:"workloads"`
		Policies    int    `json:"policies"`
		Unprotected int    `json:"unprotected"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out[0].Name != "prod" {
		t.Fatalf("got %+v", out)
	}
	if out[0].Workloads != 2 || out[0].Policies != 1 {
		t.Errorf("got %+v", out[0])
	}
	// api has no policy selecting it at all.
	if out[0].Unprotected != 1 {
		t.Errorf("got %d unprotected, want 1", out[0].Unprotected)
	}
}
