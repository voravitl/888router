<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# shared

## Purpose
Cross-provider auth and identity helpers shared by executors: Cline auth, machine-id, and Qoder helpers.

## Key Files
| File | Description |
|------|-------------|
| `clineAuth.js` | Cline authentication helper |
| `machineId.js` | Machine identity for device-bound auth |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `qoder/` | Qoder provider shared helpers |

## For AI Agents

### Working In This Directory
- Auth helpers are security-sensitive: never log tokens or keys; preserve existing header/signature behavior.
- New shared auth helper goes here only if 2+ executors consume it; single-provider logic stays in its executor.

### Testing Requirements
- Auth changes need a vitest suite under `tests/` with mocked credentials, run from repo root.

## Dependencies

### Internal
- `../executors/` — primary consumers
- `../config/` — auth endpoints and constants

<!-- MANUAL: -->
