package npeval

import (
	"reflect"
	"testing"
)

func tcp(from, to int32) PortRange {
	return PortRange{Protocol: ProtocolTCP, From: from, To: to}
}

func TestIntersectPorts(t *testing.T) {
	tests := []struct {
		name   string
		a, b   []PortRange
		want   []PortRange
		wantOK bool
	}{
		{
			// An empty list means "all ports", so it is the identity element.
			name:   "empty left is unrestricted",
			a:      nil,
			b:      []PortRange{tcp(443, 443)},
			want:   []PortRange{tcp(443, 443)},
			wantOK: true,
		},
		{
			name:   "empty right is unrestricted",
			a:      []PortRange{tcp(443, 443)},
			b:      nil,
			want:   []PortRange{tcp(443, 443)},
			wantOK: true,
		},
		{
			name:   "both empty stays unrestricted",
			a:      nil,
			b:      nil,
			want:   nil,
			wantOK: true,
		},
		{
			name:   "identical single ports",
			a:      []PortRange{tcp(443, 443)},
			b:      []PortRange{tcp(443, 443)},
			want:   []PortRange{tcp(443, 443)},
			wantOK: true,
		},
		{
			name:   "disjoint ports intersect to nothing",
			a:      []PortRange{tcp(443, 443)},
			b:      []PortRange{tcp(80, 80)},
			want:   nil,
			wantOK: false,
		},
		{
			name:   "overlapping ranges narrow",
			a:      []PortRange{tcp(8000, 9000)},
			b:      []PortRange{tcp(8500, 9500)},
			want:   []PortRange{tcp(8500, 9000)},
			wantOK: true,
		},
		{
			name:   "all ports of a protocol narrows to the range",
			a:      []PortRange{{Protocol: ProtocolTCP, AllPorts: true}},
			b:      []PortRange{tcp(443, 443)},
			want:   []PortRange{tcp(443, 443)},
			wantOK: true,
		},
		{
			name:   "all ports on both sides stays all ports",
			a:      []PortRange{{Protocol: ProtocolTCP, AllPorts: true}},
			b:      []PortRange{{Protocol: ProtocolTCP, AllPorts: true}},
			want:   []PortRange{{Protocol: ProtocolTCP, AllPorts: true}},
			wantOK: true,
		},
		{
			// Protocols never mix, so a TCP allowance and a UDP allowance share
			// nothing even on the same port number.
			name:   "different protocols never intersect",
			a:      []PortRange{tcp(53, 53)},
			b:      []PortRange{{Protocol: ProtocolUDP, From: 53, To: 53}},
			want:   nil,
			wantOK: false,
		},
		{
			name:   "unresolved named port matches nothing",
			a:      []PortRange{{Protocol: ProtocolTCP, Name: "http"}},
			b:      []PortRange{tcp(8080, 8080)},
			want:   nil,
			wantOK: false,
		},
		{
			name:   "name is preserved through intersection",
			a:      []PortRange{{Protocol: ProtocolTCP, Name: "http", From: 8080, To: 8080}},
			b:      []PortRange{tcp(8000, 9000)},
			want:   []PortRange{{Protocol: ProtocolTCP, Name: "http", From: 8080, To: 8080}},
			wantOK: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := intersectPorts(tt.a, tt.b)
			if ok != tt.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tt.wantOK)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}

func TestResolveNamedPorts(t *testing.T) {
	api := Workload{
		Ref:   ObjectRef{Kind: "Deployment", Namespace: "prod", Name: "api"},
		Ports: []NamedPort{{Name: "http", Port: 8080, Protocol: ProtocolTCP}},
	}
	web := Workload{
		Ref:   ObjectRef{Kind: "Deployment", Namespace: "prod", Name: "web"},
		Ports: []NamedPort{{Name: "http", Port: 3000, Protocol: ProtocolTCP}},
	}

	t.Run("resolves against a single target", func(t *testing.T) {
		got := resolveNamedPorts([]PortRange{{Protocol: ProtocolTCP, Name: "http"}}, []Workload{api})
		want := []PortRange{{Protocol: ProtocolTCP, Name: "http", From: 8080, To: 8080}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %v, want %v", got, want)
		}
	})

	t.Run("one name can resolve to several numbers across targets", func(t *testing.T) {
		got := resolveNamedPorts([]PortRange{{Protocol: ProtocolTCP, Name: "http"}}, []Workload{api, web})
		want := []PortRange{
			{Protocol: ProtocolTCP, Name: "http", From: 3000, To: 3000},
			{Protocol: ProtocolTCP, Name: "http", From: 8080, To: 8080},
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %v, want %v", got, want)
		}
	})

	t.Run("protocol must match too", func(t *testing.T) {
		got := resolveNamedPorts([]PortRange{{Protocol: ProtocolUDP, Name: "http"}}, []Workload{api})
		if len(got) != 0 {
			t.Errorf("got %v, want nothing", got)
		}
	})

	t.Run("a name no container declares permits nothing", func(t *testing.T) {
		got := resolveNamedPorts([]PortRange{{Protocol: ProtocolTCP, Name: "grpc"}}, []Workload{api})
		if len(got) != 0 {
			t.Errorf("got %v, want nothing", got)
		}
	})

	t.Run("numeric entries pass through untouched", func(t *testing.T) {
		got := resolveNamedPorts([]PortRange{tcp(443, 443)}, nil)
		if !reflect.DeepEqual(got, []PortRange{tcp(443, 443)}) {
			t.Errorf("got %v", got)
		}
	})
}

func TestPortsAllow(t *testing.T) {
	tests := []struct {
		name  string
		ports []PortRange
		proto Protocol
		port  int32
		want  bool
	}{
		{"empty allows everything", nil, ProtocolTCP, 443, true},
		{"exact match", []PortRange{tcp(443, 443)}, ProtocolTCP, 443, true},
		{"outside the set", []PortRange{tcp(443, 443)}, ProtocolTCP, 80, false},
		{"inside a range", []PortRange{tcp(8000, 9000)}, ProtocolTCP, 8500, true},
		{"range is inclusive at the top", []PortRange{tcp(8000, 9000)}, ProtocolTCP, 9000, true},
		{"just past a range", []PortRange{tcp(8000, 9000)}, ProtocolTCP, 9001, false},
		{"wrong protocol", []PortRange{tcp(53, 53)}, ProtocolUDP, 53, false},
		{"all ports of the protocol", []PortRange{{Protocol: ProtocolUDP, AllPorts: true}}, ProtocolUDP, 53, true},
		{"unresolved named port", []PortRange{{Protocol: ProtocolTCP, Name: "http"}}, ProtocolTCP, 8080, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := portsAllow(tt.ports, tt.proto, tt.port); got != tt.want {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}
