package cluster

import (
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/FathiQ/marsad/pkg/npeval"
)

// A graph node is a controller, not a pod: a Deployment's pods all share the
// same template labels, so they are selected identically by every policy and
// drawing them separately would add thousands of nodes without adding
// information.
//
// The labels that matter are therefore the pod *template* labels. A controller's
// own metadata labels are frequently different and are never what a policy
// matches against.

func workloadFromDeployment(d *appsv1.Deployment) npeval.Workload {
	return npeval.Workload{
		Ref:      npeval.ObjectRef{Group: "apps", Kind: "Deployment", Namespace: d.Namespace, Name: d.Name},
		Kind:     npeval.KindDeployment,
		Labels:   d.Spec.Template.Labels,
		Replicas: int(d.Status.Replicas),
		Ports:    portsFromPodSpec(&d.Spec.Template.Spec),
	}
}

func workloadFromStatefulSet(s *appsv1.StatefulSet) npeval.Workload {
	return npeval.Workload{
		Ref:      npeval.ObjectRef{Group: "apps", Kind: "StatefulSet", Namespace: s.Namespace, Name: s.Name},
		Kind:     npeval.KindStatefulSet,
		Labels:   s.Spec.Template.Labels,
		Replicas: int(s.Status.Replicas),
		Ports:    portsFromPodSpec(&s.Spec.Template.Spec),
	}
}

func workloadFromDaemonSet(d *appsv1.DaemonSet) npeval.Workload {
	return npeval.Workload{
		Ref:      npeval.ObjectRef{Group: "apps", Kind: "DaemonSet", Namespace: d.Namespace, Name: d.Name},
		Kind:     npeval.KindDaemonSet,
		Labels:   d.Spec.Template.Labels,
		Replicas: int(d.Status.CurrentNumberScheduled),
		Ports:    portsFromPodSpec(&d.Spec.Template.Spec),
	}
}

func workloadFromJob(j *batchv1.Job) npeval.Workload {
	return npeval.Workload{
		Ref:      npeval.ObjectRef{Group: "batch", Kind: "Job", Namespace: j.Namespace, Name: j.Name},
		Kind:     npeval.KindJob,
		Labels:   j.Spec.Template.Labels,
		Replicas: int(j.Status.Active),
		Ports:    portsFromPodSpec(&j.Spec.Template.Spec),
	}
}

func workloadFromCronJob(c *batchv1.CronJob) npeval.Workload {
	tmpl := c.Spec.JobTemplate.Spec.Template
	return npeval.Workload{
		Ref:      npeval.ObjectRef{Group: "batch", Kind: "CronJob", Namespace: c.Namespace, Name: c.Name},
		Kind:     npeval.KindCronJob,
		Labels:   tmpl.Labels,
		Replicas: len(c.Status.Active),
		Ports:    portsFromPodSpec(&tmpl.Spec),
	}
}

// workloadFromPod represents a pod that no controller owns — a debug pod, a
// bare manifest, something an operator created directly. These are easy to miss
// and are exactly the kind of thing that ends up unprotected, so they get their
// own node rather than being dropped.
func workloadFromPod(p *corev1.Pod) npeval.Workload {
	return npeval.Workload{
		Ref:      npeval.ObjectRef{Kind: "Pod", Namespace: p.Namespace, Name: p.Name},
		Kind:     npeval.KindPod,
		Labels:   p.Labels,
		Replicas: 1,
		Ports:    portsFromPodSpec(&p.Spec),
	}
}

// portsFromPodSpec collects named container ports, which is what lets a policy
// referring to a port by name be resolved to a number.
func portsFromPodSpec(spec *corev1.PodSpec) []npeval.NamedPort {
	var out []npeval.NamedPort
	add := func(containers []corev1.Container) {
		for _, c := range containers {
			for _, p := range c.Ports {
				if p.Name == "" {
					continue
				}
				proto := npeval.ProtocolTCP
				if p.Protocol != "" {
					proto = npeval.Protocol(p.Protocol)
				}
				out = append(out, npeval.NamedPort{
					Name:     p.Name,
					Port:     p.ContainerPort,
					Protocol: proto,
				})
			}
		}
	}
	add(spec.InitContainers)
	add(spec.Containers)
	return out
}

// ownerRef returns the controlling owner of an object, if it has one.
func ownerRef(meta metav1.Object) *metav1.OwnerReference {
	for i, ref := range meta.GetOwnerReferences() {
		if ref.Controller != nil && *ref.Controller {
			return &meta.GetOwnerReferences()[i]
		}
	}
	return nil
}
