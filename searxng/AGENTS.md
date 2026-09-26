<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# searxng

## Purpose
SearXNG meta-search engine config: `settings.yml` mounted read-only into the container. Reproducible from repo; secret comes from `SEARXNG_SECRET` env at runtime, never hardcoded here.

## Key Files
| File | Description |
|------|-------------|
| `settings.yml` | SearXNG settings (no real secrets) |

## For AI Agents

### Working In This Directory
- Never put a real secret in `settings.yml`; env override only.
- Deployed via `k8s/base/searxng.yaml` + `searxng-configmap.yaml`.

## Dependencies

### Internal
- `../k8s/base/searxng.yaml` — workload consuming this config

<!-- MANUAL: -->
