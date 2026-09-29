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
| **`888router`** | Deployment + Service (ClusterIP `router-888`) | `20128` | `80`/`443` via Ingress | Next.js API Gateway & Web UI |
| **`headroom`** | Deployment + Service (ClusterIP) | `8787` | `8787` (ClusterIP only) | Anthropic Context Cache Proxy |
| **`searxng`** | Deployment + Service (ClusterIP) | `8080` | `8080` (ClusterIP only) | Meta-search engine for web grounding |
| **`888router-data-pvc`** | PersistentVolumeClaim | - | - | 10Gi Local Path Storage for `/app/data` (SQLite DB) |

> No Service publishes a NodePort/LoadBalancer port. Host port `20129` is used by
> the **compose clone** (see below), so keep the cluster internal-only or move the
> clone to another host port.

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

## 🧬 Run a Second Instance Under Docker Compose (`888route`)

The `888route` service in the repo-root `docker-compose.yml` runs a **clone** of
the gateway next to the k8s deployment, on host port `20129`. It shares the
compose `headroom` and `searxng` services rather than starting its own.

```text
k8s (namespace 888router)              docker compose project "888router"
┌───────────────────────────┐          ┌──────────────────────────────┐
│ deploy/888router          │          │ 888route   host :20129       │
│   PVC 888router-data-pvc  │  seed   │   vol 888route-data          │
│   :20128 ──► Ingress 80/443          │   :20128 ──► 0.0.0.0:20129   │
│ headroom · searxng (svc)  │ ──────► │ headroom · searxng (shared)  │
└───────────────────────────┘  copy   └──────────────────────────────┘
```

**It is a copy, never a shared mount.** SQLite is single-writer: two live
writers on one database file corrupt it. The k8s pod keeps its own PVC and the
clone keeps its own volume.

### Create it

```bash
# 1. Seed the volume from the live k8s PVC (k8s stays online; snapshot is
#    taken with node:sqlite backup() and validated with PRAGMA integrity_check)
./scripts/k8s-seed-compose-data.sh

# 2. Pull the live Secret + ConfigMap into .env.route (gitignored, mode 600).
#    Also rewrites BASE_URL / NINEROUTER_PUBLIC_URL to http://localhost:20129
#    and sets AUTH_COOKIE_SECURE=false — the clone is plain HTTP on localhost.
./scripts/k8s-sync-secret.sh --pull

# 3. Start it
docker compose up -d 888route
curl http://localhost:20129/api/version
```

### Re-seeding an existing clone

Re-running the seed script **discards everything written to the clone**, so it
needs `--force` and refuses while `888route` is running:

```bash
docker compose stop 888route
./scripts/k8s-seed-compose-data.sh --force
docker compose up -d 888route
```

### Sync direction is one-way

The clone is a point-in-time snapshot that does **not** sync back. The two
instances diverge from the moment the seed completes — API keys created on the
clone exist only there, usage recorded on the clone is not in k8s. Re-seed to
pull the k8s state across again.

### Login

`jwt-secret`, `machine-id` and the `auth/` CLI secret are copied along with the
database, so the same dashboard password and API keys as the k8s instance work on
both. Only `db/backups/` (~200MB of historical upgrade snapshots) and `bin/`
(lazily downloaded `cloudflared` / `tailscale` helpers) are skipped — the clone
re-downloads those on first use.

---

## 🔍 Verification & Endpoints

- **Kubernetes Instance**: `https://888router.k8s.orb.local/api/version`
- **Compose Clone (`888route`)**: `http://localhost:20129/api/version`
- **Kubernetes Pod Status**: `kubectl get pods -n 888router`
- **Kubernetes Service Status**: `kubectl get svc -n 888router`
- **Compose Clone Status**: `docker compose ps 888route`
