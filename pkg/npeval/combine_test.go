package npeval

import (
	"net/netip"
	"testing"
)

func prefix(t *testing.T, s string) netip.Prefix {
	t.Helper()
	p, err := netip.ParsePrefix(s)
	if err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return p
}

func podsPeer(refs ...ObjectRef) ResolvedPeer {
	return ResolvedPeer{Kind: PeerPods, Workloads: refs, Namespaces: []string{"prod"}, Display: "pods"}
}

func ref(name string) ObjectRef {
	return ObjectRef{Kind: "Deployment", Namespace: "prod", Name: name}
}

func TestIntersectPeers(t *testing.T) {
	api, web := ref("api"), ref("web")

	t.Run("any is the identity element", func(t *testing.T) {
		other := podsPeer(api)
		got, approx, _, ok := intersectPeers(ResolvedPeer{Kind: PeerAny}, other)
		if !ok || approx || got.Kind != PeerPods {
			t.Fatalf("got %+v approx=%v ok=%v", got, approx, ok)
		}
		got, _, _, ok = intersectPeers(other, ResolvedPeer{Kind: PeerAny})
		if !ok || got.Kind != PeerPods {
			t.Fatalf("got %+v ok=%v", got, ok)
		}
	})

	t.Run("pods intersect on workloads", func(t *testing.T) {
		got, _, _, ok := intersectPeers(podsPeer(api, web), podsPeer(web))
		if !ok {
			t.Fatal("expected an intersection")
		}
		if len(got.Workloads) != 1 || got.Workloads[0] != web {
			t.Errorf("got %v, want [%v]", got.Workloads, web)
		}
	})

	t.Run("pods with no workload or namespace in common are empty", func(t *testing.T) {
		a := ResolvedPeer{Kind: PeerPods, Workloads: []ObjectRef{api}, Namespaces: []string{"prod"}}
		b := ResolvedPeer{Kind: PeerPods, Workloads: []ObjectRef{web}, Namespaces: []string{"staging"}}
		if _, _, _, ok := intersectPeers(a, b); ok {
			t.Error("expected no intersection")
		}
	})

	t.Run("nested cidrs keep the narrower", func(t *testing.T) {
		a := ResolvedPeer{Kind: PeerCIDR, CIDR: prefix(t, "10.0.0.0/8")}
		b := ResolvedPeer{Kind: PeerCIDR, CIDR: prefix(t, "10.1.0.0/16")}
		got, _, _, ok := intersectPeers(a, b)
		if !ok || got.CIDR.String() != "10.1.0.0/16" {
			t.Errorf("got %v ok=%v, want 10.1.0.0/16", got.CIDR, ok)
		}
	})

	t.Run("disjoint cidrs intersect to nothing", func(t *testing.T) {
		a := ResolvedPeer{Kind: PeerCIDR, CIDR: prefix(t, "10.0.0.0/8")}
		b := ResolvedPeer{Kind: PeerCIDR, CIDR: prefix(t, "192.168.0.0/16")}
		if _, _, _, ok := intersectPeers(a, b); ok {
			t.Error("expected no intersection")
		}
	})

	t.Run("exceptions inside the result are carried over", func(t *testing.T) {
		a := ResolvedPeer{Kind: PeerCIDR, CIDR: prefix(t, "10.0.0.0/8"), Except: []netip.Prefix{prefix(t, "10.1.2.0/24")}}
		b := ResolvedPeer{Kind: PeerCIDR, CIDR: prefix(t, "10.1.0.0/16")}
		got, _, _, ok := intersectPeers(a, b)
		if !ok {
			t.Fatal("expected an intersection")
		}
		if len(got.Except) != 1 || got.Except[0].String() != "10.1.2.0/24" {
			t.Errorf("got except %v, want [10.1.2.0/24]", got.Except)
		}
	})

	t.Run("exceptions outside the result are dropped", func(t *testing.T) {
		// Narrowing to 10.1.0.0/16 already excludes 10.9.0.0/24, so carrying the
		// exception would be noise.
		a := ResolvedPeer{Kind: PeerCIDR, CIDR: prefix(t, "10.0.0.0/8"), Except: []netip.Prefix{prefix(t, "10.9.0.0/24")}}
		b := ResolvedPeer{Kind: PeerCIDR, CIDR: prefix(t, "10.1.0.0/16")}
		got, _, _, ok := intersectPeers(a, b)
		if !ok || len(got.Except) != 0 {
			t.Errorf("got except %v, want none", got.Except)
		}
	})

	t.Run("domains intersect to the narrower pattern", func(t *testing.T) {
		a := ResolvedPeer{Kind: PeerDomain, Domain: "*.amazonaws.com"}
		b := ResolvedPeer{Kind: PeerDomain, Domain: "*.s3.amazonaws.com"}
		got, _, _, ok := intersectPeers(a, b)
		if !ok || got.Domain != "*.s3.amazonaws.com" {
			t.Errorf("got %q ok=%v", got.Domain, ok)
		}
	})

	t.Run("a domain against a cidr is undecidable, not denied", func(t *testing.T) {
		// Deciding this needs DNS resolution, which is a runtime fact. Reporting
		// a confident answer either way would be wrong.
		a := ResolvedPeer{Kind: PeerDomain, Domain: "*.s3.amazonaws.com"}
		b := ResolvedPeer{Kind: PeerCIDR, CIDR: prefix(t, "52.0.0.0/8")}
		got, approx, note, ok := intersectPeers(a, b)
		if !ok || !approx {
			t.Fatalf("got ok=%v approx=%v, want both true", ok, approx)
		}
		if got.Kind != PeerDomain || note == "" {
			t.Errorf("got %+v note=%q", got, note)
		}
	})

	t.Run("pods against a cidr is flagged rather than dropped", func(t *testing.T) {
		got, approx, note, ok := intersectPeers(podsPeer(api), ResolvedPeer{Kind: PeerCIDR, CIDR: prefix(t, "10.0.0.0/8")})
		if !ok || !approx || note == "" {
			t.Fatalf("got ok=%v approx=%v note=%q", ok, approx, note)
		}
		if got.Kind != PeerPods {
			t.Errorf("got kind %v, want pods", got.Kind)
		}
	})

	t.Run("pods against a domain is genuinely empty", func(t *testing.T) {
		// Unlike a CIDR, a public domain name never resolves to a cluster pod.
		if _, _, _, ok := intersectPeers(podsPeer(api), ResolvedPeer{Kind: PeerDomain, Domain: "s3.amazonaws.com"}); ok {
			t.Error("expected no intersection")
		}
	})
}

func TestCombineLayers(t *testing.T) {
	dnsPort := []PortRange{{Protocol: ProtocolUDP, From: 53, To: 53}}
	httpsPort := []PortRange{{Protocol: ProtocolTCP, From: 443, To: 443}}

	k8sLayer := Layer{
		Provider: "k8s",
		Isolated: true,
		Allows: []Allow{
			{Peer: ResolvedPeer{Kind: PeerCIDR, CIDR: prefix(t, "0.0.0.0/0")}, Ports: httpsPort, Via: []RuleID{"np#egress[0]"}},
		},
	}
	anpLayer := Layer{
		Provider: "aws-anp",
		Isolated: true,
		Allows: []Allow{
			{Peer: ResolvedPeer{Kind: PeerDomain, Domain: "*.s3.amazonaws.com"}, Ports: httpsPort, Via: []RuleID{"anp#egress[0]"}},
		},
	}

	t.Run("a single layer passes through", func(t *testing.T) {
		got := combineLayers([]Layer{k8sLayer}, CombineIntersect)
		if len(got) != 1 || got[0].Peer.Kind != PeerCIDR {
			t.Fatalf("got %+v", got)
		}
	})

	t.Run("intersecting layers keeps traceability from both", func(t *testing.T) {
		got := combineLayers([]Layer{k8sLayer, anpLayer}, CombineIntersect)
		if len(got) != 1 {
			t.Fatalf("got %d allows, want 1: %+v", len(got), got)
		}
		if !got[0].Approximate {
			t.Error("a domain intersected with a CIDR must be marked approximate")
		}
		if len(got[0].Via) != 2 {
			t.Errorf("got Via %v, want both rules", got[0].Via)
		}
	})

	t.Run("union keeps both layers' allows", func(t *testing.T) {
		got := combineLayers([]Layer{k8sLayer, anpLayer}, CombineUnion)
		if len(got) != 2 {
			t.Fatalf("got %d allows, want 2: %+v", len(got), got)
		}
	})

	t.Run("intersecting on incompatible ports yields nothing", func(t *testing.T) {
		dnsOnly := Layer{
			Provider: "aws-anp",
			Isolated: true,
			Allows: []Allow{
				{Peer: ResolvedPeer{Kind: PeerCIDR, CIDR: prefix(t, "0.0.0.0/0")}, Ports: dnsPort, Via: []RuleID{"anp#egress[0]"}},
			},
		}
		if got := combineLayers([]Layer{k8sLayer, dnsOnly}, CombineIntersect); len(got) != 0 {
			t.Errorf("got %+v, want nothing", got)
		}
	})
}

func TestMergeAllows(t *testing.T) {
	peer := ResolvedPeer{Kind: PeerCIDR, CIDR: netip.MustParsePrefix("10.0.0.0/8")}

	t.Run("same peer unions ports and rule references", func(t *testing.T) {
		got := mergeAllows([]Allow{
			{Peer: peer, Ports: []PortRange{tcp(80, 80)}, Via: []RuleID{"a"}},
			{Peer: peer, Ports: []PortRange{tcp(443, 443)}, Via: []RuleID{"b"}},
		})
		if len(got) != 1 {
			t.Fatalf("got %d allows, want 1", len(got))
		}
		if len(got[0].Ports) != 2 {
			t.Errorf("got ports %v, want both", got[0].Ports)
		}
		if len(got[0].Via) != 2 {
			t.Errorf("got via %v, want both", got[0].Via)
		}
	})

	t.Run("an unrestricted rule subsumes port restrictions on the same peer", func(t *testing.T) {
		got := mergeAllows([]Allow{
			{Peer: peer, Ports: []PortRange{tcp(80, 80)}, Via: []RuleID{"a"}},
			{Peer: peer, Ports: nil, Via: []RuleID{"b"}},
		})
		if len(got) != 1 || len(got[0].Ports) != 0 {
			t.Errorf("got %+v, want a single unrestricted allow", got)
		}
	})
}
