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
