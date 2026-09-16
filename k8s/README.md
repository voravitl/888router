# 888router Kubernetes Deployment Guide (Kustomize)

This directory contains the production-ready Kubernetes manifests structured with **Kustomize (Base + Overlays)** for deploying the full **888router Stack** (`888router`, `headroom`, and `searxng`) with persistent SQLite storage and zero-downtime migration capabilities.

---

## 📁 Kustomize Structure

```text
k8s/
├── kustomization.yaml         # Root pointer (defaults to overlays/local)
├── base/                      # Base manifests shared across environments
│   ├── kustomization.yaml
│   ├── namespace.yaml
│   ├── searxng-configmap.yaml
│   ├── configmap.yaml
│   ├── secrets.example.yaml
│   ├── pvc.yaml
│   ├── headroom.yaml
│   ├── searxng.yaml
│   └── 888router.yaml
└── overlays/
    ├── local/                 # Local machine / OrbStack (Port 20129, LoadBalancer)
    │   └── kustomization.yaml
    └── prd/                   # Production cluster (Ingress + TLS + router.tcbank.local)
        ├── kustomization.yaml
        └── ingress.yaml
```

---

## 🏗️ Architecture & Components

| Component | Resource | Port (Internal) | Port (External / Service) | Description |
|---|---|---|---|---|
| **`888router`** | Deployment + Service (LoadBalancer) | `20128` | `20129` | Next.js API Gateway & Web UI |
| **`headroom`** | Deployment + Service (ClusterIP) | `8787` | `8787` | Anthropic Context Cache Proxy |
| **`searxng`** | Deployment + Service (ClusterIP) | `8080` | `8080` | Meta-search engine for web grounding |
| **`888router-data-pvc`** | PersistentVolumeClaim | - | - | 10Gi Local Path Storage for `/app/data` (SQLite DB) |

---

## 🚀 Quick Start & Deployment

### 1. Sync Secrets from `.env`
Run the helper script to create/update Kubernetes secrets without committing sensitive values:
```bash
./scripts/k8s-sync-secret.sh .env
```

### 2. Deploy via Kustomize

**Local / OrbStack (รันคู่ขนานกับ Docker บนพอร์ต 20129):**
```bash
kubectl apply -k k8s/
# หรือระบุ overlay ตรงๆ:
kubectl apply -k k8s/overlays/local
```

**Production Cluster (พร้อม Ingress `router.tcbank.local`):**
```bash
kubectl apply -k k8s/overlays/prd
```

### 3. Migrate Live Data from Docker (Non-Destructive)
Clone live SQLite DB and configuration from existing Docker container into K8s PVC while keeping Docker running:
```bash
./scripts/k8s-migrate-data.sh 888router
```

---

## 🔍 Verification & Endpoints

- **Docker Instance (Existing)**: `http://localhost:20128/api/version`
- **Kubernetes Instance (Parallel)**: `http://localhost:20129/api/version`
- **Kubernetes Pod Status**: `kubectl get pods -n 888router`
- **Kubernetes Service Status**: `kubectl get svc -n 888router`
