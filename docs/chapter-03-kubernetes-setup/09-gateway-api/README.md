# 09 — Gateway API

This section enables the Kubernetes Gateway API on the cluster using Cilium's built-in controller. Gateway API is the official Kubernetes SIG Network successor to the Ingress API, providing centralized access to all observability and management UIs under a single IP. No additional ingress controller is required. Cilium handles Gateway API natively via its Envoy integration.

> ⚠️ **Run this section on k8s-master only.**

---

## Prerequisites

- [ ] Completed [08 — Cluster Storage](../08-cluster-storage/README.md)
- [ ] All four nodes Ready
- [ ] SSH access to k8s-master

---

## Access Layout

All observability and management UIs are reachable via a single IP on k8s-worker-3. HTTPRoutes for each service are created in their respective chapters once each component is deployed.

| UI | Path | Chapter |
|---|---|---|
| Grafana | /grafana | 4 |
| Prometheus | /prometheus | 4 |
| Hubble UI | /hubble | 4 |
| Longhorn | /longhorn | 3 |
| free5GC WebUI | /free5gc | 5 |

---

## Gateway IP Address

The Gateway is assigned a dedicated IP from the local network using Cilium LB-IPAM.

| Parameter | Value |
|---|---|
| Gateway IP | 192.168.18.230 |
| Access URL | http://192.168.18.230/\<path\> |

---

## Step 1 — Connect to k8s-master

```bash
ssh unmsm@192.168.18.210
```

---

## Step 2 — Install Gateway API CRDs

Gateway API CRDs must be installed before enabling the feature in Cilium. Cilium 1.19 passes Gateway API v1.4.0 conformance.

```bash
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.4.1/standard-install.yaml
```

<img src="img/gateway-crds.png" alt="kubectl apply gateway api CRDs output" width="800">
<sub>Figure 1. Gateway API v1.4.1 CRDs installed.</sub>
<br><br>

---

## Step 3 — Enable Gateway API in Cilium

```bash
helm upgrade cilium cilium/cilium \
  --version 1.19.3 \
  --namespace kube-system \
  --reuse-values \
  --set gatewayAPI.enabled=true
```

<img src="img/cilium-upgrade.png" alt="helm upgrade cilium output" width="800">
<sub>Figure 2. Cilium upgraded with Gateway API enabled.</sub>
<br><br>

Restart Cilium to apply the new configuration:

```bash
kubectl rollout restart deployment/cilium-operator -n kube-system
kubectl rollout restart ds/cilium -n kube-system
```

<img src="img/cilium-restart.png" alt="cilium rollout restart output" width="800">
<sub>Figure 3. Cilium operator and DaemonSet restarted.</sub>
<br><br>

---

## Step 4 — Verify GatewayClass

```bash
kubectl get gatewayclass
```

<img src="img/gatewayclass.png" alt="kubectl get gatewayclass showing cilium Accepted" width="800">
<sub>Figure 4. Cilium GatewayClass registered and Accepted.</sub>
<br><br>

---

## Step 5 — Create IP Pool

Create the IP pool assigning the reserved address to the Gateway:

```bash
kubectl apply -f - <<EOF
apiVersion: cilium.io/v2
kind: CiliumLoadBalancerIPPool
metadata:
  name: local-pool
spec:
  blocks:
  - cidr: "192.168.18.230/32"
EOF
```

<img src="img/ippool-created.png" alt="CiliumLoadBalancerIPPool created output" width="500">
<sub>Figure 5. IP pool created. 192.168.18.230 is reserved for the Gateway and outside the router DHCP pool.</sub>
<br><br>

---

## Step 6 — Create the Observability Gateway

```bash
kubectl create namespace monitoring
```

```bash
kubectl apply -f - <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: observability-gateway
  namespace: monitoring
spec:
  gatewayClassName: cilium
  listeners:
  - name: http
    protocol: HTTP
    port: 80
    allowedRoutes:
      namespaces:
        from: All
EOF
```

<img src="img/gateway-created.png" alt="namespace and gateway created output" width="800">
<sub>Figure 6. monitoring namespace and observability-gateway created.</sub>
<br><br>

---

## Step 7 — Verify

```bash
kubectl get gateway -n monitoring
kubectl get svc -n monitoring
```

<img src="img/gateway-verify.png" alt="gateway showing PROGRAMMED True and IP 192.168.18.230" width="800">
<sub>Figure 7. Gateway PROGRAMMED: True with address 192.168.18.230. All observability UIs will be accessible at http://192.168.18.230/path once HTTPRoutes are configured in later chapters.</sub>
<br><br>

> **Note:** HTTPRoutes for each UI are created in their respective chapters once each service is deployed.

---

## References

- \[1\] Cilium Documentation, "Gateway API Support."
      https://docs.cilium.io/en/stable/network/servicemesh/gateway-api/gateway-api/ [Accessed: May 2026]
- \[2\] Cilium Documentation, "LB-IPAM."
      https://docs.cilium.io/en/stable/network/lb-ipam/ [Accessed: May 2026]
- \[3\] Kubernetes SIG Network, "Gateway API."
      https://gateway-api.sigs.k8s.io/ [Accessed: May 2026]

---

✅ You are here: `chapter-03-kubernetes-setup / 09-ingress`

⏭️ Next Chapter: [Chapter 4 — Observability Stack → 01 Prometheus and Grafana](../../chapter-04-observability/01-prometheus-grafana/README.md
