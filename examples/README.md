# Example policies

Sample manifests for demos, tests, and seeing what Marsad reports.

| File | What it shows |
|---|---|
| `00-namespaces.yaml` | namespaces with the labels the policies select on |
| `01-workloads.yaml` | the deployments the graph draws |
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

`20-aws-domain-egress.yaml` needs the AWS VPC CNI's
`applicationnetworkpolicies.networking.k8s.aws` CRD. On other clusters it will
fail to apply, and Marsad will show the "domain policies not available on this
cluster" badge rather than pretending the rules exist.
