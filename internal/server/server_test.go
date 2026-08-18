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
