package npeval

import "testing"

// The AWS CRD documents its wildcard as matching "one or more entire labels",
// which is broader than the single-label glob most people assume. These cases
// are transcribed from the examples in the CRD's own field documentation.
func TestMatchDomain(t *testing.T) {
	tests := []struct {
		name    string
		pattern string
		domain  string
		want    bool
	}{
		{"exact match", "kubernetes.io", "kubernetes.io", true},
		{"exact does not match subdomain", "kubernetes.io", "www.kubernetes.io", false},
		{"exact does not match blog subdomain", "kubernetes.io", "blog.kubernetes.io", false},
		{"exact does not match prefixed name", "kubernetes.io", "my-kubernetes.io", false},
		{"exact does not match other domain", "kubernetes.io", "wikipedia.org", false},

		{"specific exact match", "blog.kubernetes.io", "blog.kubernetes.io", true},
		{"specific does not match sibling", "blog.kubernetes.io", "www.kubernetes.io", false},
		{"specific does not match parent", "blog.kubernetes.io", "kubernetes.io", false},

		{"wildcard matches one label", "*.kubernetes.io", "www.kubernetes.io", true},
		{"wildcard matches another label", "*.kubernetes.io", "blog.kubernetes.io", true},
		// The case people get wrong: "*" is not limited to a single label.
		{"wildcard matches multiple labels", "*.kubernetes.io", "latest.blog.kubernetes.io", true},
		{"wildcard does not match the bare domain", "*.kubernetes.io", "kubernetes.io", false},
		{"wildcard does not match other domain", "*.kubernetes.io", "wikipedia.org", false},
		{"wildcard does not match suffix without dot", "*.kubernetes.io", "mykubernetes.io", false},

		{"case insensitive", "*.S3.Amazonaws.com", "my-bucket.s3.amazonaws.com", true},
		{"trailing dot normalized on domain", "*.kubernetes.io", "www.kubernetes.io.", true},
		{"trailing dot normalized on pattern", "*.kubernetes.io.", "www.kubernetes.io", true},

		{"empty pattern", "", "kubernetes.io", false},
		{"empty domain", "*.kubernetes.io", "", false},

		{"regional s3 wildcard", "*.s3.us-east-1.amazonaws.com", "logs.s3.us-east-1.amazonaws.com", true},
		{"regional wildcard rejects other region", "*.s3.us-east-1.amazonaws.com", "logs.s3.eu-west-1.amazonaws.com", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := MatchDomain(tt.pattern, tt.domain); got != tt.want {
				t.Errorf("MatchDomain(%q, %q) = %v, want %v", tt.pattern, tt.domain, got, tt.want)
			}
		})
	}
}

func TestDomainContains(t *testing.T) {
	tests := []struct {
		name         string
		outer, inner string
		want         bool
	}{
		{"identical exact", "kubernetes.io", "kubernetes.io", true},
		{"identical wildcard", "*.kubernetes.io", "*.kubernetes.io", true},
		{"wildcard contains exact subdomain", "*.kubernetes.io", "blog.kubernetes.io", true},
		{"wildcard contains deep exact subdomain", "*.kubernetes.io", "a.b.kubernetes.io", true},
		{"wildcard does not contain bare domain", "*.kubernetes.io", "kubernetes.io", false},
		{"broad wildcard contains narrow wildcard", "*.amazonaws.com", "*.s3.amazonaws.com", true},
		{"narrow wildcard does not contain broad", "*.s3.amazonaws.com", "*.amazonaws.com", false},
		{"exact does not contain wildcard", "kubernetes.io", "*.kubernetes.io", false},
		{"disjoint", "*.kubernetes.io", "*.wikipedia.org", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := DomainContains(tt.outer, tt.inner); got != tt.want {
				t.Errorf("DomainContains(%q, %q) = %v, want %v", tt.outer, tt.inner, got, tt.want)
			}
		})
	}
}

func TestIntersectDomains(t *testing.T) {
	tests := []struct {
		name   string
		a, b   string
		want   string
		wantOK bool
	}{
		{"identical", "s3.amazonaws.com", "s3.amazonaws.com", "s3.amazonaws.com", true},
		{"wildcard and contained exact", "*.amazonaws.com", "s3.amazonaws.com", "s3.amazonaws.com", true},
		{"exact and containing wildcard", "s3.amazonaws.com", "*.amazonaws.com", "s3.amazonaws.com", true},
		{"nested wildcards keep the narrower", "*.amazonaws.com", "*.s3.amazonaws.com", "*.s3.amazonaws.com", true},
		{"disjoint exacts", "s3.amazonaws.com", "ec2.amazonaws.com", "", false},
		{"disjoint wildcards", "*.s3.amazonaws.com", "*.ec2.amazonaws.com", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := IntersectDomains(tt.a, tt.b)
			if ok != tt.wantOK || got != tt.want {
				t.Errorf("IntersectDomains(%q, %q) = (%q, %v), want (%q, %v)",
					tt.a, tt.b, got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

func TestDomainLabels(t *testing.T) {
	tests := []struct {
		pattern string
		want    int
	}{
		{"*.amazonaws.com", 2},
		{"*.s3.amazonaws.com", 3},
		{"*.s3.us-east-1.amazonaws.com", 4},
		{"kubernetes.io", 2},
		{"", 0},
	}
	for _, tt := range tests {
		t.Run(tt.pattern, func(t *testing.T) {
			if got := DomainLabels(tt.pattern); got != tt.want {
				t.Errorf("DomainLabels(%q) = %d, want %d", tt.pattern, got, tt.want)
			}
		})
	}
}
