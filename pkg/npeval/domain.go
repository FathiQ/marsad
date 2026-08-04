package npeval

import "strings"

// Domain matching follows the AWS ApplicationNetworkPolicy CRD exactly, and its
// wildcard is broader than most people expect:
//
//   - "*" is a prefix-only specifier and matches one or more *entire* labels.
//   - kubernetes.io matches only kubernetes.io.
//   - *.kubernetes.io matches www.kubernetes.io, blog.kubernetes.io and
//     latest.blog.kubernetes.io — but not kubernetes.io itself.
//   - Partial-label matches are not supported.
//
// That "*" spans multiple labels is why *.amazonaws.com is worth a finding: it
// reaches every AWS service in every region, not just one.

// NormalizeDomain lowercases a domain and strips the trailing dot the CRD's
// pattern permits, so "S3.Amazonaws.com." and "s3.amazonaws.com" compare equal.
func NormalizeDomain(d string) string {
	return strings.ToLower(strings.TrimSuffix(strings.TrimSpace(d), "."))
}

// IsWildcardDomain reports whether a pattern uses the "*." prefix.
func IsWildcardDomain(pattern string) bool {
	return strings.HasPrefix(NormalizeDomain(pattern), "*.")
}

// DomainLabels counts the labels in a pattern, ignoring the wildcard.
// "*.amazonaws.com" is 2, and the lower the count on a wildcard the broader the
// reach — the basis of the overly-broad-wildcard finding.
func DomainLabels(pattern string) int {
	p := NormalizeDomain(pattern)
	p = strings.TrimPrefix(p, "*.")
	if p == "" {
		return 0
	}
	return strings.Count(p, ".") + 1
}

// MatchDomain reports whether a concrete domain name matches a pattern.
func MatchDomain(pattern, name string) bool {
	p, n := NormalizeDomain(pattern), NormalizeDomain(name)
	if p == "" || n == "" {
		return false
	}
	if suffix, ok := strings.CutPrefix(p, "*."); ok {
		// One or more whole labels must precede the suffix, so the name has to
		// end with ".suffix" — never equal the suffix itself.
		return strings.HasSuffix(n, "."+suffix)
	}
	return p == n
}

// DomainContains reports whether every name matched by inner is also matched by
// outer, i.e. inner ⊆ outer.
func DomainContains(outer, inner string) bool {
	o, i := NormalizeDomain(outer), NormalizeDomain(inner)
	if o == "" || i == "" {
		return false
	}
	oSuffix, oWild := strings.CutPrefix(o, "*.")
	iSuffix, iWild := strings.CutPrefix(i, "*.")

	if !oWild {
		// An exact pattern matches exactly one name, so it can only contain an
		// identical exact pattern.
		return !iWild && o == i
	}
	if !iWild {
		return MatchDomain(o, i)
	}
	// *.a.b ⊆ *.b, and *.b ⊆ *.b.
	return iSuffix == oSuffix || strings.HasSuffix(iSuffix, "."+oSuffix)
}

// IntersectDomains returns the pattern matching exactly the names both accept.
// ok is false when no name satisfies both.
//
// Two overlapping-but-unordered wildcards cannot occur: with prefix-only
// wildcards, any two patterns are either disjoint or one contains the other.
func IntersectDomains(a, b string) (string, bool) {
	switch {
	case DomainContains(a, b):
		return NormalizeDomain(b), true
	case DomainContains(b, a):
		return NormalizeDomain(a), true
	default:
		return "", false
	}
}
