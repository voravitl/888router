# Incident Postmortem & Standard: Preventing K8s 503 Outages During Agent Deployments

**Date:** 2026-09-26 · **Cluster:** OrbStack (local) · **Namespace:** `888router`
**Severity:** CRITICAL (Recurring Deployment Outage Risk across all Agent Harnesses)

---

## 1. Executive Summary & Problem Statement
Whenever various AI agent harnesses (Claude Code, Hermes, Codex, Grok, etc.) perform a deployment, the web application (`http://router.k8s.orb.local`) frequently experiences complete downtime with **HTTP 503 Service Unavailable**.

## 2. Root Cause Analysis
Three compounding factors caused the 503 downtime:

1. **`Deployment.spec.strategy.type: Recreate`**:
   Because SQLite database runs on a single ReadWriteOnce (RWO) persistent volume, multi-replica concurrent writing is forbidden. Therefore, Kubernetes terminates the existing healthy pod **BEFORE** starting the new pod.
2. **Missing Local Docker Build**:
   Agents applied `kubectl apply -k k8s/overlays/local` immediately after tagging, assuming Kubernetes would pull the image from Docker Hub. However, GitHub Actions takes 5–10 minutes to build and push the new container image.
3. **`ImagePullBackOff` & 0 Ready Replicas**:
   Because the image was not yet on Docker Hub and had not been built locally, K8s entered `ErrImagePull` / `ImagePullBackOff`. With 0 running pods, Nginx Ingress immediately started serving **503 Service Unavailable** to all clients.
4. **Tag Discrepancy (`v` prefix)**:
   Some agents built Docker images with `v<version>` (e.g. `voravitl/888router:v0.15.120`), whereas the Kubernetes deployment manifests strictly specify `<version>` without `v` (`voravitl/888router:0.15.120`). K8s could not find the image locally even if built!

---

## 3. Mandatory Zero-Downtime Deployment Protocol for ALL Agents

Every agent modifying or releasing 888router MUST follow this exact sequence:

```text
[Release Prep]
   │
   ├─► 1. Bump version in package.json AND 3 K8s files:
   │      - k8s/base/888router.yaml: image: voravitl/888router:<version> (NO 'v')
   │      - k8s/overlays/local/kustomization.yaml: newTag: <version> (NO 'v')
   │      - k8s/overlays/prd/kustomization.yaml: newTag: <version> (NO 'v')
   │
   ├─► 2. MANDATORY: Build image locally into Docker daemon BEFORE touching K8s:
   │      docker build -t voravitl/888router:<version> -t voravitl/888router:latest .
   │      (OrbStack shares this image cache with K8s; starts pod in ~2s with ZERO network wait)
   │
   ├─► 3. Deploy local K8s overlay:
   │      kubectl apply -k k8s/overlays/local
   │
   ├─► 4. Block and wait for rollout:
   │      kubectl rollout status deploy/888router -n 888router --timeout=120s
   │
   ├─► 5. Verify live endpoint:
   │      curl -s http://router.k8s.orb.local/api/version
   │      (Must return HTTP 200 and match <version>)
   │
   └─► 6. IF Rollout fails or timeout occurs:
          IMMEDIATELY ROLLBACK:
          kubectl rollout undo deploy/888router -n 888router
```

---

## 4. Key Rules (Do Not Violate)
- **NEVER use `docker compose up`**: The active workload is managed by Kubernetes (`namespace: 888router`).
- **NEVER apply K8s without building the image locally first**: Waiting for Docker Hub in K8s kills the healthy pod and guarantees a 5-10 minute 503 outage.
- **Docker image tag has NO `v`**: Git tag has `v` (`v0.15.120`), Docker image tag has NO `v` (`0.15.120`).
