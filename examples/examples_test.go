// Package examples_test checks that every manifest in this directory is valid
// YAML and normalizes cleanly through the real providers.
//
// The examples are demo material, so they are the first thing a new user applies
// and the first thing that embarrasses the project if it is broken. Running them
// through the same code path the server uses catches both a stray tab and a
// policy shape the normalizer refuses.
package examples_test

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	utilyaml "k8s.io/apimachinery/pkg/util/yaml"
	"sigs.k8s.io/yaml"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"

	awsv1alpha1 "github.com/FathiQ/marsad/pkg/apis/awsanp/v1alpha1"
	"github.com/FathiQ/marsad/pkg/npeval"
	"github.com/FathiQ/marsad/pkg/npeval/provider/awsanp"
	"github.com/FathiQ/marsad/pkg/npeval/provider/k8s"
)

func TestExampleManifests(t *testing.T) {
	files, err := filepath.Glob("*.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Fatal("no example manifests found")
	}

	var policies int
	for _, file := range files {
		t.Run(file, func(t *testing.T) {
			for i, doc := range splitDocs(t, file) {
				var meta metav1.TypeMeta
				if err := yaml.Unmarshal(doc, &meta); err != nil {
					t.Fatalf("document %d: %v", i, err)
				}

				switch meta.Kind {
				case "NetworkPolicy":
					var np networkingv1.NetworkPolicy
					if err := yaml.UnmarshalStrict(doc, &np); err != nil {
						t.Fatalf("document %d: %v", i, err)
					}
					p, err := k8s.NormalizePolicy(&np)
					if err != nil {
						t.Fatalf("document %d (%s): %v", i, np.Name, err)
					}
					checkPolicy(t, p)
					policies++

				case "ApplicationNetworkPolicy":
					var a awsv1alpha1.ApplicationNetworkPolicy
					if err := yaml.UnmarshalStrict(doc, &a); err != nil {
						t.Fatalf("document %d: %v", i, err)
					}
					p, err := awsanp.NormalizePolicy(&a)
					if err != nil {
						t.Fatalf("document %d (%s): %v", i, a.Name, err)
					}
					checkPolicy(t, p)
					policies++

				case "Namespace", "Deployment", "StatefulSet", "DaemonSet", "Service":
					// Fixture objects; only their YAML validity matters here.
				case "":
					t.Fatalf("document %d has no kind", i)
				default:
					t.Fatalf("document %d: unexpected kind %q", i, meta.Kind)
				}
			}
		})
	}

	if policies == 0 {
		t.Error("expected the examples to contain policies")
	}
	t.Logf("normalized %d policies across %d files", policies, len(files))
}

// TestExamplesShowAnUnprotectedWorkload guards what the demo is *for*.
//
// Marsad's headline number is "N unprotected of M workloads", and for a long
// time the example cluster could not produce one in a user namespace: both
// policies in marsad-demo carry `podSelector: {}`, so everything there is
// selected by something. The only unprotected workloads on a demo cluster were
// therefore in kube-system, and nobody reads infrastructure noise as a finding
// about their own cluster.
//
// The worker in marsad-demo-edge fixes that, and this test stops a future
// policy quietly covering it — which would leave the demo passing every other
// test while no longer demonstrating the thing it exists to demonstrate.
func TestExamplesShowAnUnprotectedWorkload(t *testing.T) {
	b := npeval.NewBuilder()

	files, err := filepath.Glob("*.yaml")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		for i, doc := range splitDocs(t, file) {
			var meta metav1.TypeMeta
			if err := yaml.Unmarshal(doc, &meta); err != nil {
				t.Fatalf("%s document %d: %v", file, i, err)
			}

			switch meta.Kind {
			case "Namespace":
				var ns corev1.Namespace
				if err := yaml.UnmarshalStrict(doc, &ns); err != nil {
					t.Fatalf("%s document %d: %v", file, i, err)
				}
				b.AddNamespace(npeval.Namespace{Name: ns.Name, Labels: ns.Labels})

			case "Deployment":
				var d appsv1.Deployment
				if err := yaml.UnmarshalStrict(doc, &d); err != nil {
					t.Fatalf("%s document %d: %v", file, i, err)
				}
				// Pod *template* labels: policies select pods, and a controller's
				// own labels are not what they match against.
				b.AddWorkload(npeval.Workload{
					Ref: npeval.ObjectRef{
						Group: "apps", Kind: "Deployment",
						Namespace: d.Namespace, Name: d.Name,
					},
					Kind:   npeval.KindDeployment,
					Labels: d.Spec.Template.Labels,
				})

			case "NetworkPolicy":
				var np networkingv1.NetworkPolicy
				if err := yaml.UnmarshalStrict(doc, &np); err != nil {
					t.Fatalf("%s document %d: %v", file, i, err)
				}
				p, err := k8s.NormalizePolicy(&np)
				if err != nil {
					t.Fatalf("%s document %d: %v", file, i, err)
				}
				b.AddPolicy(p)

			case "ApplicationNetworkPolicy":
				var a awsv1alpha1.ApplicationNetworkPolicy
				if err := yaml.UnmarshalStrict(doc, &a); err != nil {
					t.Fatalf("%s document %d: %v", file, i, err)
				}
				p, err := awsanp.NormalizePolicy(&a)
				if err != nil {
					t.Fatalf("%s document %d: %v", file, i, err)
				}
				b.AddPolicy(p)
			}
		}
	}

	snap, err := b.Build()
	if err != nil {
		t.Fatalf("building a snapshot from the examples: %v", err)
	}
	e := npeval.New(snap)

	var unprotected []npeval.ObjectRef
	for _, w := range snap.Workloads("") {
		iso := e.Isolation(w.Ref)
		if !iso.Ingress && !iso.Egress {
			unprotected = append(unprotected, w.Ref)
		}
	}

	if len(unprotected) == 0 {
		t.Fatal("no example workload is unprotected; the demo cannot show Marsad's headline finding")
	}

	const (
		wantNamespace = "marsad-demo-edge"
		wantName      = "worker"
	)
	found := false
	for _, ref := range unprotected {
		if ref.Namespace == wantNamespace && ref.Name == wantName {
			found = true
		}
	}
	if !found {
		t.Errorf("expected %s/%s to be unprotected, but the unprotected set is %v",
			wantNamespace, wantName, unprotected)
	}

	// The near miss that makes it interesting, and what B4's "closest misses"
	// will report: the namespace does have a policy, it just does not select
	// this pod. An unprotected workload in a namespace with no policies at all
	// would be a far weaker demonstration.
	if policies := snap.Policies(wantNamespace); len(policies) == 0 {
		t.Errorf("%s has no policies; the point of the worker is that it slipped "+
			"through a namespace that looks covered", wantNamespace)
	}
}

func checkPolicy(t *testing.T, p npeval.Policy) {
	t.Helper()
	if p.Ref.Name == "" || p.Ref.Namespace == "" {
		t.Errorf("policy is missing a name or namespace: %+v", p.Ref)
	}
	if p.Types == 0 {
		t.Errorf("%s governs no direction", p.Ref)
	}
	// Rule identifiers are the anchor for the UI's edge-to-YAML traceability, so
	// every rule must carry one.
	for _, dir := range []npeval.Direction{npeval.DirIngress, npeval.DirEgress} {
		for i, r := range p.Rules(dir) {
			if r.ID == "" {
				t.Errorf("%s %s rule %d has no id", p.Ref, dir, i)
			}
			if r.Path == "" {
				t.Errorf("%s %s rule %d has no field path", p.Ref, dir, i)
			}
		}
	}
}

func splitDocs(t *testing.T, file string) [][]byte {
	t.Helper()

	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}

	var out [][]byte
	r := utilyaml.NewYAMLReader(bufio.NewReader(bytes.NewReader(raw)))
	for {
		doc, err := r.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		if len(bytes.TrimSpace(stripComments(doc))) > 0 {
			out = append(out, doc)
		}
	}
	return out
}

// stripComments drops comment-only lines so a leading explanatory block does not
// read as a document.
func stripComments(doc []byte) []byte {
	var b bytes.Buffer
	for _, line := range bytes.Split(doc, []byte("\n")) {
		if trimmed := bytes.TrimSpace(line); len(trimmed) == 0 || trimmed[0] == '#' {
			continue
		}
		b.Write(line)
		b.WriteByte('\n')
	}
	return b.Bytes()
}
