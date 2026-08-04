package npeval

import (
	"fmt"
	"strings"
)

// Protocol is a transport protocol. The Kubernetes API defaults to TCP when a
// NetworkPolicyPort omits it.
type Protocol string

// The transport protocols a policy may name.
const (
	ProtocolTCP  Protocol = "TCP"
	ProtocolUDP  Protocol = "UDP"
	ProtocolSCTP Protocol = "SCTP"
)

// AllProtocols is the set a rule covers when it does not name one.
var AllProtocols = []Protocol{ProtocolTCP, ProtocolUDP, ProtocolSCTP}

// ObjectRef identifies a Kubernetes object. Group is empty for core objects.
type ObjectRef struct {
	Group     string `json:"group,omitempty"`
	Kind      string `json:"kind"`
	Namespace string `json:"namespace,omitempty"`
	Name      string `json:"name"`
}

func (r ObjectRef) String() string {
	var b strings.Builder
	if r.Group != "" {
		b.WriteString(r.Group)
		b.WriteByte('/')
	}
	b.WriteString(r.Kind)
	b.WriteByte('/')
	if r.Namespace != "" {
		b.WriteString(r.Namespace)
		b.WriteByte('/')
	}
	b.WriteString(r.Name)
	return b.String()
}

// Compare orders refs deterministically so evaluator output is stable.
func (r ObjectRef) Compare(o ObjectRef) int {
	if c := strings.Compare(r.Group, o.Group); c != 0 {
		return c
	}
	if c := strings.Compare(r.Kind, o.Kind); c != 0 {
		return c
	}
	if c := strings.Compare(r.Namespace, o.Namespace); c != 0 {
		return c
	}
	return strings.Compare(r.Name, o.Name)
}

// WorkloadKind is the controller type a workload node represents.
type WorkloadKind string

// The controller kinds a workload node can represent.
const (
	KindDeployment  WorkloadKind = "Deployment"
	KindStatefulSet WorkloadKind = "StatefulSet"
	KindDaemonSet   WorkloadKind = "DaemonSet"
	KindJob         WorkloadKind = "Job"
	KindCronJob     WorkloadKind = "CronJob"
	// KindPod is used for pods with no controlling owner.
	KindPod WorkloadKind = "Pod"
)

// Namespace is a namespace and the labels a namespaceSelector matches against.
type Namespace struct {
	Name   string            `json:"name"`
	Labels map[string]string `json:"labels,omitempty"`
}

// NamedPort is a container port declaration, used to resolve policies that
// reference ports by name.
type NamedPort struct {
	Name     string   `json:"name"`
	Port     int32    `json:"port"`
	Protocol Protocol `json:"protocol"`
}

// Workload is the unit of the graph: one node per controller, not per pod.
//
// Labels are the *pod template* labels, because policies select pods. The
// controller's own labels are irrelevant to policy matching and must not be used
// here.
type Workload struct {
	Ref      ObjectRef         `json:"ref"`
	Kind     WorkloadKind      `json:"kind"`
	Labels   map[string]string `json:"labels,omitempty"`
	Replicas int               `json:"replicas"`
	Ports    []NamedPort       `json:"ports,omitempty"`
}

// Direction distinguishes the two halves of a policy.
type Direction int

// The two directions policy governs, evaluated independently of each other.
const (
	DirIngress Direction = iota
	DirEgress
)

func (d Direction) String() string {
	switch d {
	case DirIngress:
		return "ingress"
	case DirEgress:
		return "egress"
	default:
		return fmt.Sprintf("Direction(%d)", int(d))
	}
}
