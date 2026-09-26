<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# k8s

## Purpose
Kubernetes manifests (Kustomize): base resources plus `local` and `prd` overlays deploying `voravitl/888router:*` into namespace `888router`.

## Key Files
| File | Description |
|------|-------------|
| `kustomization.yaml` | Top-level kustomization |
| `README.md` | Deploy usage notes |
| `base/888router.yaml` | Deployment + Service (keep `imagePullPolicy: IfNotPresent`) |
| `base/namespace.yaml` | `888router` namespace |
| `base/ingress.yaml` | Ingress routing |
| `base/pvc.yaml` | SQLite single-writer PVC (reason strategy is `Recreate`) |
| `base/configmap.yaml` | Non-secret config |
| `base/secrets.example.yaml` | Secret template (never commit real secrets) |
| `base/networkpolicy.yaml` | Network policy |
| `base/headroom.yaml` | Headroom resources |
| `base/searxng.yaml` | SearXNG resources (+ `searxng-configmap.yaml`) |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `base/` | Shared resources (see table above) |
| `overlays/local/` | Local OrbStack overlay (`images[].newTag` pinned per release) |
| `overlays/prd/` | Production overlay (`images[].newTag` pinned per release) |

## For AI Agents

### Working In This Directory
- Version bump touches 3 files: `base/888router.yaml` (image tag, WITHOUT `v`) plus `newTag` in BOTH overlays. Git tag has `v`; image tag never does.
- Strategy is `Recreate` (SQLite single-writer PVC) — always `docker build` locally BEFORE `kubectl apply -k`, or the pod hits `ImagePullBackOff` and Ingress returns 503.
- Never `docker compose up` — production runs on K8s, not compose.
- Never commit real secrets; copy `secrets.example.yaml` pattern only.

### Testing Requirements
- After apply: `kubectl rollout status deploy/888router -n 888router` then `curl /api/version` must equal `package.json` version.

## Dependencies

### External
- Kustomize, kubectl, OrbStack (local daemon shared with K8s)

<!-- MANUAL: -->
