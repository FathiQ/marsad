package server_test

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
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
	// Unset in this fixture, so this pins the fallback rather than the stamp.
	// Something must always come back: a running Marsad that cannot say which
	// build it is turns "did the fix ship?" into guesswork.
	if meta["version"] != "dev" {
		t.Errorf("version = %v, want the dev fallback", meta["version"])
	}
}

func TestMetaReportsTheBuildItWasStampedWith(t *testing.T) {
	s := server.New(server.Options{Source: &fixedSource{state: &cluster.State{
		Snapshot: emptySnapshot(t), Revision: 1, BuiltAt: time.Now(),
	}}, Version: "v9.9.9"})

	_, body := do(t, s, http.MethodGet, "/api/meta", "")
	var meta map[string]any
	if err := json.Unmarshal(body, &meta); err != nil {
		t.Fatal(err)
	}
	if meta["version"] != "v9.9.9" {
		t.Errorf("version = %v, want the value the build stamped in", meta["version"])
	}
}

func emptySnapshot(t *testing.T) *npeval.Snapshot {
	t.Helper()
	snap, err := npeval.NewBuilder().Build()
	if err != nil {
		t.Fatal(err)
	}
	return snap
}

func TestFrontendCacheHeaders(t *testing.T) {
	// An embed.FS has a zero ModTime, so the file server sends no Last-Modified
	// and no ETag. With no Cache-Control either, a browser may keep serving the
	// index it already had, and an upgrade looks exactly like one that never
	// happened — which is how a fixed build got reported as still broken.
	res, _ := do(t, testServer(t), http.MethodGet, "/", "")
	if got := res.Header.Get("Cache-Control"); got != "no-cache" {
		t.Errorf("index Cache-Control = %q, want no-cache so a new build is seen", got)
	}

	// The asset rule is checked on the decision rather than through a request:
	// only index.html is embedded outside a container build, so a request for a
	// fingerprinted asset 404s, and Go strips headers off an error response.
	for _, tc := range []struct{ path, want string }{
		{"/assets/index-Br61CARm.js", "public, max-age=31536000, immutable"},
		{"/assets/index-DhK2c.css", "public, max-age=31536000, immutable"},
		{"/", "no-cache"},
		{"/index.html", "no-cache"},
		{"/favicon.svg", "no-cache"},
	} {
		if got := server.CacheControlForTest(tc.path); got != tc.want {
			t.Errorf("cacheControl(%q) = %q, want %q", tc.path, got, tc.want)
		}
	}
}

// worldServer carries a policy whose ipBlock is 0.0.0.0/0, which is the case
// the caution line exists for.
func worldServer(t *testing.T) *server.Server {
	t.Helper()

	np := &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Namespace: "prod", Name: "open-ingress"},
		Spec: networkingv1.NetworkPolicySpec{
			PodSelector: *sel("app", "db"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			Ingress: []networkingv1.NetworkPolicyIngressRule{{
				From: []networkingv1.NetworkPolicyPeer{
					{IPBlock: &networkingv1.IPBlock{CIDR: "0.0.0.0/0"}},
				},
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
		AddWorkload(deploy("prod", "db", "app", "db")).
		AddPolicy(policy).
		Build()
	if err != nil {
		t.Fatal(err)
	}
	state := &cluster.State{Snapshot: snap, Revision: 1, BuiltAt: time.Now()}
	return server.New(server.Options{Source: &fixedSource{state: state}})
}

type ruleDetailView struct {
	ID       string                `json:"id"`
	Policy   struct{ Name string } `json:"policy"`
	Path     string                `json:"path"`
	YAML     string                `json:"yaml"`
	Cautions []string              `json:"cautions"`
}

// TestRulesReturnsTheExcerptNotTheDocument is the whole point of the endpoint.
// A policy is often a hundred lines governing several directions, and an edge
// comes from exactly one entry of one list.
func TestRulesReturnsTheExcerptNotTheDocument(t *testing.T) {
	id := "networking.k8s.io/NetworkPolicy/prod/db-ingress#ingress[0]"
	res, body := do(t, testServer(t), http.MethodGet,
		"/api/rules?ids="+url.QueryEscape(id), "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", res.StatusCode, body)
	}

	var out []ruleDetailView
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode: %v — %s", err, body)
	}
	if len(out) != 1 {
		t.Fatalf("got %d rules, want 1: %s", len(out), body)
	}

	got := out[0]
	if got.Policy.Name != "db-ingress" {
		t.Errorf("policy = %q, want db-ingress", got.Policy.Name)
	}
	if got.Path != "spec.ingress[0]" {
		t.Errorf("path = %q, want spec.ingress[0]", got.Path)
	}
	// The rule, and only the rule. Not podSelector, which the rule legitimately
	// contains inside its own `from` list — the document-level keys are the ones
	// that prove this is an excerpt.
	for _, unwanted := range []string{"apiVersion", "kind:", "metadata", "policyTypes"} {
		if strings.Contains(got.YAML, unwanted) {
			t.Errorf("the excerpt contains %q, so it is the whole document:\n%s", unwanted, got.YAML)
		}
	}
	if !strings.Contains(got.YAML, "from:") || !strings.Contains(got.YAML, "5432") {
		t.Errorf("the excerpt should be the rule itself:\n%s", got.YAML)
	}
}

// TestRulesDerivesTheWorldCaution: the sentence comes from the rule, not from a
// list of strings to look out for.
func TestRulesDerivesTheWorldCaution(t *testing.T) {
	id := "networking.k8s.io/NetworkPolicy/prod/open-ingress#ingress[0]"
	res, body := do(t, worldServer(t), http.MethodGet,
		"/api/rules?ids="+url.QueryEscape(id), "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", res.StatusCode, body)
	}

	var out []ruleDetailView
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("got %d rules, want 1", len(out))
	}
	if len(out[0].Cautions) == 0 {
		t.Fatal("a rule admitting 0.0.0.0/0 should carry a caution")
	}
	if !strings.Contains(out[0].Cautions[0], "every address") {
		t.Errorf("caution = %q, want it to say the range covers every address", out[0].Cautions[0])
	}
}

// TestRulesSaysNothingAboutAnOrdinaryRule keeps the caution meaningful: one
// that fires on every rule is decoration.
func TestRulesSaysNothingAboutAnOrdinaryRule(t *testing.T) {
	id := "networking.k8s.io/NetworkPolicy/prod/db-ingress#ingress[0]"
	_, body := do(t, testServer(t), http.MethodGet, "/api/rules?ids="+url.QueryEscape(id), "")

	var out []ruleDetailView
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out) == 1 && len(out[0].Cautions) != 0 {
		t.Errorf("an ordinary pod-to-pod rule needs no caution, got %v", out[0].Cautions)
	}
}

func TestRulesRejectsAnEmptyOrOversizedRequest(t *testing.T) {
	s := testServer(t)

	if res, _ := do(t, s, http.MethodGet, "/api/rules", ""); res.StatusCode != http.StatusBadRequest {
		t.Errorf("no ids: status %d, want 400", res.StatusCode)
	}

	many := make([]string, 65)
	for i := range many {
		many[i] = "x"
	}
	res, _ := do(t, s, http.MethodGet, "/api/rules?ids="+strings.Join(many, ","), "")
	if res.StatusCode != http.StatusBadRequest {
		t.Errorf("65 ids: status %d, want 400", res.StatusCode)
	}
}

// TestRulesSkipsUnknownIdentifiers: a stale edge from a graph the client is
// still holding must not fail the whole request.
func TestRulesSkipsUnknownIdentifiers(t *testing.T) {
	_, body := do(t, testServer(t), http.MethodGet,
		"/api/rules?ids=nope%23ingress%5B0%5D", "")

	var out []ruleDetailView
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out) != 0 {
		t.Errorf("got %d rules for an unknown id, want 0", len(out))
	}
}

// TestHealthCarriesTheFaultVerbatim: the API server's own sentence is the only
// thing that makes a permission failure fixable, and every layer that
// paraphrases it can turn one problem into a different one.
func TestHealthCarriesTheFaultVerbatim(t *testing.T) {
	gr := schema.GroupResource{Group: "apps", Resource: "deployments"}
	apiErr := apierrors.NewForbidden(gr, "", errors.New("marsad cannot list deployments"))
	fault := cluster.NewFault(apiErr, "https://api.example")

	s := server.New(server.Options{
		Source: &fixedSource{state: nil},
		Fault:  func() *cluster.Fault { return fault },
	})

	res, body := do(t, s, http.MethodGet, "/api/health", "")
	// Deliberately 200: the chart's liveness probe points here, and restarting
	// the pod would take away the screen that explains why it cannot read.
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d, want 200: %s", res.StatusCode, body)
	}

	var out struct {
		Ready bool `json:"ready"`
		Fault struct {
			Kind    string `json:"kind"`
			Message string `json:"message"`
			Host    string `json:"host"`
		} `json:"fault"`
		ClusterRole string `json:"clusterRole"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode: %v — %s", err, body)
	}

	if out.Ready {
		t.Error("ready must be false when the cluster cannot be read")
	}
	if out.Fault.Kind != "forbidden" {
		t.Errorf("kind = %q, want forbidden", out.Fault.Kind)
	}
	if out.Fault.Message != apiErr.Error() {
		t.Errorf("message = %q, want the error verbatim %q", out.Fault.Message, apiErr.Error())
	}
	if out.Fault.Host != "https://api.example" {
		t.Errorf("host = %q", out.Fault.Host)
	}

	// The way out travels with the problem, and grants reads only.
	if !strings.Contains(out.ClusterRole, "kind: ClusterRole") {
		t.Fatalf("a permission fault should carry the ClusterRole:\n%s", out.ClusterRole)
	}
	for _, verb := range []string{"create", "update", "patch", "delete"} {
		if strings.Contains(out.ClusterRole, verb) {
			t.Errorf("the offered ClusterRole grants %q", verb)
		}
	}
}

// TestHealthOffersNoClusterRoleForOtherFaults keeps the offer meaningful: an
// unreachable API server is not fixed by applying RBAC, and suggesting it would
// send someone to change permissions that were never the problem.
func TestHealthOffersNoClusterRoleForOtherFaults(t *testing.T) {
	fault := cluster.NewFault(apierrors.NewUnauthorized("expired"), "")
	s := server.New(server.Options{
		Source: &fixedSource{state: nil},
		Fault:  func() *cluster.Fault { return fault },
	})

	_, body := do(t, s, http.MethodGet, "/api/health", "")
	var out struct {
		ClusterRole string `json:"clusterRole"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	if out.ClusterRole != "" {
		t.Errorf("an unauthorized fault should not offer a ClusterRole, got %q", out.ClusterRole)
	}
}

func TestHealthIsQuietWhenNothingIsWrong(t *testing.T) {
	_, body := do(t, testServer(t), http.MethodGet, "/api/health", "")
	if strings.Contains(string(body), "fault") {
		t.Errorf("a healthy server should report no fault: %s", body)
	}
}

// TestPoliciesAreListable: policies were the one thing in the cluster with no
// way to look them up. You could find a workload and read what selects it, but
// not go the other way, which is the direction a name arrives in.
func TestPoliciesAreListable(t *testing.T) {
	res, body := do(t, testServer(t), http.MethodGet, "/api/policies", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", res.StatusCode, body)
	}

	var out []struct {
		Ref      struct{ Name, Namespace string } `json:"ref"`
		Provider string                           `json:"provider"`
		Types    string                           `json:"types"`
		Selector string                           `json:"selector"`
		Selects  int                              `json:"selects"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode: %v — %s", err, body)
	}
	if len(out) != 1 {
		t.Fatalf("got %d policies, want 1: %s", len(out), body)
	}

	got := out[0]
	if got.Ref.Name != "db-ingress" || got.Ref.Namespace != "prod" {
		t.Errorf("ref = %+v", got.Ref)
	}
	if got.Types != "Ingress" {
		t.Errorf("types = %q, want Ingress — the mask travels as names", got.Types)
	}
	if got.Selector != "app=db" {
		t.Errorf("selector = %q, want app=db", got.Selector)
	}
	// The db deployment, and only it.
	if got.Selects != 1 {
		t.Errorf("selects = %d, want 1", got.Selects)
	}
}

// TestPolicySelectingNothingSaysZero: a policy matching no workload is usually
// label drift. It protects exactly as much as no policy at all, while looking
// like coverage in any list that does not count.
func TestPolicySelectingNothingSaysZero(t *testing.T) {
	np := &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Namespace: "prod", Name: "orphaned"},
		Spec: networkingv1.NetworkPolicySpec{
			PodSelector: *sel("app", "does-not-exist"),
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
		},
	}
	policy, err := k8s.NormalizePolicy(np)
	if err != nil {
		t.Fatal(err)
	}
	snap, err := npeval.NewBuilder().
		AddNamespace(npeval.Namespace{Name: "prod"}).
		AddWorkload(deploy("prod", "api", "app", "api")).
		AddPolicy(policy).
		Build()
	if err != nil {
		t.Fatal(err)
	}
	s := server.New(server.Options{Source: &fixedSource{
		state: &cluster.State{Snapshot: snap, Revision: 1, BuiltAt: time.Now()},
	}})

	_, body := do(t, s, http.MethodGet, "/api/policies", "")
	var out []struct {
		Selects int `json:"selects"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out[0].Selects != 0 {
		t.Errorf("expected one policy selecting nothing, got %+v", out)
	}
}
