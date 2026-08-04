# EKS Auto Mode

Observed on `dev-eks-135-compat` (EKS v1.35, Auto Mode), 2026-08-05.

On an Auto Mode cluster, AWS runs the control-plane add-ons outside the
customer's view. `kube-system` is **empty**: no CoreDNS pods, no CoreDNS
Service, no kube-proxy, no aws-node, and no `kube-dns` endpoints. The only
Service present is `eks-extension-metrics-api`.

```
$ kubectl get pods -n kube-system
No resources found in kube-system namespace.

$ kubectl get pods -A -l k8s-app=kube-dns
No resources found
```

This is not a permissions problem and not something Marsad should work around.
It is what the API server actually reports, and Marsad reports it faithfully:
`kube-system` shows zero workloads.

## Why it matters for evaluation

**The canonical DNS allowance selects nothing.** Almost every real-world egress
policy contains some variant of:

```yaml
- to:
    - namespaceSelector:
        matchLabels: {kubernetes.io/metadata.name: kube-system}
      podSelector:
        matchLabels: {k8s-app: kube-dns}
  ports: [{protocol: UDP, port: 53}]
```

On Auto Mode that peer resolves to an empty workload set, because the pods it
names do not exist as far as the API is concerned. The allowance is still real —
the CNI enforces against the actual DNS endpoints — but Marsad cannot see the
other end of it.

The graph handles this already: a pod peer that resolves to no workloads falls
back to drawing the namespace node, so the edge still appears rather than
silently vanishing.

## Constraints this places on the findings engine

These are not optional. Getting them wrong makes Marsad cry wolf on every Auto
Mode cluster in existence.

1. **The "egress-isolated but no DNS allowance" finding must key on port 53
   being permitted to *something*** — not on the peer resolving to CoreDNS pods.
   Keying it on resolved pods would fire on every correctly configured Auto Mode
   cluster.

2. **Do not add a "peer selects zero workloads" finding.** It is tempting, and it
   would be wrong here for a policy that is entirely correct. The existing LOW
   "dead policy" rule is safe because it keys on the policy's *own* podSelector,
   which does resolve normally.

3. **A workload count of zero in `kube-system` is not a red flag** and must not
   feed the security score. It is the expected shape of an Auto Mode cluster.

## Open question

Because the managed DNS pods are not selectable by a podSelector at all, Auto
Mode users cannot write the canonical rule and have it mean anything to the
enforcement layer either — they presumably have to allow port 53 to a CIDR
instead. Worth confirming against a cluster that actually has egress policies
applied, since it changes what remediation hint the DNS finding should offer.

This compounds the [layer-combination question](npeval.md#5-cross-provider-combination--corrected-after-reading-the-crd):
under strict intersection, an ApplicationNetworkPolicy permitting only 443
revokes DNS granted in the NetworkPolicy layer, and on Auto Mode there is no
CoreDNS pod to point a replacement rule at.
