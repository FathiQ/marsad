package npeval

import "slices"

// An empty []PortRange always means "every port on every protocol" — the same
// thing the Kubernetes API means by an absent or empty ports list. Keeping that
// convention end to end means empty is the identity element for intersection and
// there is no separate all-ports sentinel to forget about.

// resolveNamedPorts replaces name-referencing entries with the concrete numbers
// they resolve to on the given target workloads.
//
// A named port resolves against different pods depending on direction: for
// ingress it is a port on the pods the policy selects, for egress a port on the
// destination pods. Callers pass the right targets.
//
// An entry that resolves to nothing is dropped: a named port with no matching
// container port genuinely permits no traffic.
func resolveNamedPorts(ports []PortRange, targets []Workload) []PortRange {
	out := make([]PortRange, 0, len(ports))
	for _, p := range ports {
		if p.Name == "" {
			out = append(out, p)
			continue
		}
		var nums []int32
		for _, w := range targets {
			for _, np := range w.Ports {
				if np.Name == p.Name && np.Protocol == p.Protocol {
					if !slices.Contains(nums, np.Port) {
						nums = append(nums, np.Port)
					}
				}
			}
		}
		slices.Sort(nums)
		for _, n := range nums {
			out = append(out, PortRange{Protocol: p.Protocol, Name: p.Name, From: n, To: n})
		}
	}
	return out
}

// intersectPorts returns the ranges permitted by both sets. An empty input means
// unrestricted, so it acts as the identity.
func intersectPorts(a, b []PortRange) ([]PortRange, bool) {
	if len(a) == 0 {
		return slices.Clone(b), true
	}
	if len(b) == 0 {
		return slices.Clone(a), true
	}

	var out []PortRange
	for _, x := range a {
		for _, y := range b {
			if x.Protocol != y.Protocol {
				continue
			}
			if x.AllPorts && y.AllPorts {
				out = append(out, PortRange{Protocol: x.Protocol, AllPorts: true})
				continue
			}
			xf, xt, xok := x.bounds()
			yf, yt, yok := y.bounds()
			if !xok || !yok {
				continue
			}
			from, to := max(xf, yf), min(xt, yt)
			if from > to {
				continue
			}
			r := PortRange{Protocol: x.Protocol, From: from, To: to}
			// Keep a name when only one side carried one, so the UI can still
			// show "http=8080/TCP" after an intersection.
			switch {
			case x.Name != "" && (y.Name == "" || y.Name == x.Name):
				r.Name = x.Name
			case y.Name != "" && x.Name == "":
				r.Name = y.Name
			}
			out = append(out, r)
		}
	}
	if len(out) == 0 {
		return nil, false
	}
	return dedupePorts(out), true
}

// portsAllow reports whether a set permits one concrete protocol and port.
func portsAllow(ports []PortRange, proto Protocol, port int32) bool {
	if len(ports) == 0 {
		return true
	}
	for _, p := range ports {
		if p.Protocol != proto {
			continue
		}
		from, to, ok := p.bounds()
		if !ok {
			continue
		}
		if port >= from && port <= to {
			return true
		}
	}
	return false
}

func dedupePorts(ports []PortRange) []PortRange {
	slices.SortFunc(ports, comparePorts)
	return slices.CompactFunc(ports, func(a, b PortRange) bool { return comparePorts(a, b) == 0 })
}

func comparePorts(a, b PortRange) int {
	if c := cmpString(string(a.Protocol), string(b.Protocol)); c != 0 {
		return c
	}
	if a.AllPorts != b.AllPorts {
		if a.AllPorts {
			return -1
		}
		return 1
	}
	if a.From != b.From {
		return int(a.From) - int(b.From)
	}
	if a.To != b.To {
		return int(a.To) - int(b.To)
	}
	return cmpString(a.Name, b.Name)
}
