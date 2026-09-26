<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# tunnel

## Purpose
Tunnel clients exposing the local gateway publicly: Cloudflare (`cloudflared`) and Tailscale, plus shared lifecycle helpers.

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `cloudflare/` | cloudflared client: manager, config, healthCheck, pid |
| `tailscale/` | Tailscale client |
| `shared/` | Shared tunnel lifecycle helpers |

## For AI Agents

### Working In This Directory
- Tunnel processes are OS processes with pid files — clean up on stop, never orphan.
- Health checks gate readiness; keep their timeouts conservative.

## Dependencies

### External
- `cloudflared` binary, Tailscale daemon

<!-- MANUAL: -->
