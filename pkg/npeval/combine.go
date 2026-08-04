package npeval

import (
	"fmt"
	"net/netip"
	"slices"
)

// Providers are independent policy layers rather than one shared pool of rules.
// The AWS ApplicationNetworkPolicy CRD says so directly: traffic is allowed when
// no ANP selects the pod "and cluster policy otherwise allows the traffic". So
// rules union within a layer and combine across layers per CombineMode.

func combineLayers(layers []Layer, mode CombineMode) []Allow {
	switch len(layers) {
	case 0:
		return nil
	case 1:
		return slices.Clone(layers[0].Allows)
	}

	if mode == CombineUnion {
		var all []Allow
		for _, l := range layers {
			all = append(all, l.Allows...)
		}
		return mergeAllows(all)
	}

	acc := slices.Clone(layers[0].Allows)
	for _, l := range layers[1:] {
		acc = intersectAllows(acc, l.Allows)
		if len(acc) == 0 {
			return nil
		}
	}
	return mergeAllows(acc)
}

func intersectAllows(a, b []Allow) []Allow {
	var out []Allow
	for _, x := range a {
		for _, y := range b {
			peer, approx, note, ok := intersectPeers(x.Peer, y.Peer)
			if !ok {
				continue
			}
			ports, ok := intersectPorts(x.Ports, y.Ports)
			if !ok {
				continue
			}
			merged := Allow{
				Peer:        peer,
				Ports:       ports,
				Via:         append(slices.Clone(x.Via), y.Via...),
				Approximate: x.Approximate || y.Approximate || approx,
			}
			switch {
			case note != "":
				merged.Note = note
			case x.Note != "":
				merged.Note = x.Note
			default:
				merged.Note = y.Note
			}
			out = append(out, merged)
		}
	}
	return out
}

// intersectPeers returns the peer matching exactly what both peers match.
//
// Some pairs cannot be decided from configuration alone — a domain peer against
// a CIDR peer needs DNS resolution, which is a runtime fact Marsad deliberately
// does not have. Those return approximate=true rather than a confident answer in
// either direction; dropping them would understate reachability and keeping them
// unmarked would overstate confidence.
func intersectPeers(a, b ResolvedPeer) (peer ResolvedPeer, approximate bool, note string, ok bool) {
	// Any is the identity element.
	if a.Kind == PeerAny {
		return b, false, "", true
	}
	if b.Kind == PeerAny {
		return a, false, "", true
	}

	switch {
	case a.Kind == PeerPods && b.Kind == PeerPods:
		workloads := intersectRefs(a.Workloads, b.Workloads)
		namespaces := intersectStrings(a.Namespaces, b.Namespaces)
		if len(workloads) == 0 && len(namespaces) == 0 {
			return ResolvedPeer{}, false, "", false
		}
		return ResolvedPeer{
			Kind:       PeerPods,
			Namespaces: namespaces,
			Workloads:  workloads,
			Display:    a.Display + " ∩ " + b.Display,
		}, false, "", true

	case a.Kind == PeerCIDR && b.Kind == PeerCIDR:
		p, ok := intersectPrefix(a.CIDR, b.CIDR)
		if !ok {
			return ResolvedPeer{}, false, "", false
		}
		except := mergeExcept(p, a.Except, b.Except)
		return ResolvedPeer{
			Kind:    PeerCIDR,
			CIDR:    p,
			Except:  except,
			Display: cidrDisplay(p, except),
		}, false, "", true

	case a.Kind == PeerDomain && b.Kind == PeerDomain:
		d, ok := IntersectDomains(a.Domain, b.Domain)
		if !ok {
			return ResolvedPeer{}, false, "", false
		}
		return ResolvedPeer{Kind: PeerDomain, Domain: d, Display: d}, false, "", true

	case a.Kind == PeerDomain && b.Kind == PeerCIDR:
		return a, true, domainCIDRNote(a.Domain, b.CIDR), true
	case a.Kind == PeerCIDR && b.Kind == PeerDomain:
		return b, true, domainCIDRNote(b.Domain, a.CIDR), true

	case a.Kind == PeerPods && b.Kind == PeerCIDR:
		return a, true, podsCIDRNote(b.CIDR), true
	case a.Kind == PeerCIDR && b.Kind == PeerPods:
		return b, true, podsCIDRNote(a.CIDR), true

	default:
		// Pods against a domain: a domain name does not resolve to an in-cluster
		// pod in any realistic setup, so this is genuinely empty rather than
		// undecidable.
		return ResolvedPeer{}, false, "", false
	}
}

func domainCIDRNote(domain string, cidr netip.Prefix) string {
	return fmt.Sprintf(
		"one layer allows %s and another allows %s; whether they overlap depends on DNS resolution at runtime, which Marsad does not observe",
		domain, cidr)
}

func podsCIDRNote(cidr netip.Prefix) string {
	return fmt.Sprintf(
		"one layer allows pods and another allows %s; pod IP addresses are not modeled, so the overlap cannot be decided from configuration",
		cidr)
}

// intersectPrefix returns the narrower of two prefixes when one contains the
// other, since two CIDR prefixes are always either nested or disjoint.
func intersectPrefix(a, b netip.Prefix) (netip.Prefix, bool) {
	if !a.Overlaps(b) {
		return netip.Prefix{}, false
	}
	if a.Bits() >= b.Bits() {
		return a, true
	}
	return b, true
}

// mergeExcept keeps the exclusions that still fall inside the resulting prefix.
// An exclusion outside it is already excluded by the narrowing.
func mergeExcept(result netip.Prefix, sets ...[]netip.Prefix) []netip.Prefix {
	var out []netip.Prefix
	for _, set := range sets {
		for _, x := range set {
			if result.Overlaps(x) && !slices.Contains(out, x) {
				out = append(out, x)
			}
		}
	}
	slices.SortFunc(out, func(p, q netip.Prefix) int { return cmpString(p.String(), q.String()) })
	return out
}

func intersectRefs(a, b []ObjectRef) []ObjectRef {
	var out []ObjectRef
	for _, x := range a {
		if slices.Contains(b, x) {
			out = append(out, x)
		}
	}
	slices.SortFunc(out, ObjectRef.Compare)
	return out
}

func intersectStrings(a, b []string) []string {
	var out []string
	for _, x := range a {
		if slices.Contains(b, x) && !slices.Contains(out, x) {
			out = append(out, x)
		}
	}
	slices.Sort(out)
	return out
}
