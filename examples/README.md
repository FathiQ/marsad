# Example policies

Sample manifests for demos, tests, and seeing what Marsad reports.

| File | What it shows |
|---|---|
| `00-namespaces.yaml` | namespaces with the labels the policies select on |
| `01-workloads.yaml` | the deployments the graph draws, including one nothing protects |
| `10-default-deny.yaml` | the canonical namespace-wide default-deny |
| `11-allow-web-to-api.yaml` | a well-formed pod-to-pod allow, both halves |
| `12-egress-dns.yaml` | the DNS allowance an egress-isolated pod needs to function |
| `20-aws-domain-egress.yaml` | AWS `ApplicationNetworkPolicy` domain egress |
| `90-insecure.yaml` | NetworkPolicies that are wrong on purpose — every one trips a finding |
| `91-insecure-domains.yaml` | an overly broad domain wildcard |

Apply them to a scratch cluster:

```sh
kubectl apply -f examples/
```

## The unprotected one

`worker`, in `marsad-demo-edge`, is deliberately selected by no policy at all.
Kubernetes therefore allows everything to and from it — any port, from anywhere,
to anywhere — and Marsad draws it in danger colour and counts it in the header.

It lives in `marsad-demo-edge` rather than `marsad-demo` because it has to:
`10-default-deny.yaml` and `12-egress-dns.yaml` both carry `podSelector: {}`, so
every pod in `marsad-demo` is selected by something and nothing there can be
unprotected. `marsad-demo-edge` has a policy too — `web-allow-egress-to-api` —
but it selects `app: web`, and the worker is `app: worker`.

That near miss is the point. A namespace with no policies is obvious to anyone;
a namespace that *looks* covered, holding one workload deployed after the rules
were written, is the shape the failure actually takes in production. It is also
what the inspector's "closest misses" reads from.

`examples_test.go` asserts that this workload is still unprotected, so a policy
added later cannot quietly cover it and leave the demo unable to demonstrate
Marsad's headline finding.

`20-aws-domain-egress.yaml` needs the AWS VPC CNI's
`applicationnetworkpolicies.networking.k8s.aws` CRD. On other clusters it will
fail to apply, and Marsad will show the "domain policies not available on this
cluster" badge rather than pretending the rules exist.
