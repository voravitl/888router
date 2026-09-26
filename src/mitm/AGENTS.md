<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# mitm

## Purpose
Local MITM proxy for intercepting tool traffic: root-CA cert management, DNS config, per-tool request handlers, and proxy server lifecycle.

## Key Files
| File | Description |
|------|-------------|
| `server.js` | MITM proxy server entry |
| `manager.js` | Proxy lifecycle manager |
| `config.js` | MITM configuration |
| `dbReader.js` | Reads intercepted traffic from DB |
| `logger.js` | MITM traffic logger |
| `paths.js` | Cert/state file paths |
| `antigravityIdeVersion.js` | Antigravity IDE version helper |
| `winElevated.js` | Windows elevation helper |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `cert/` | Root CA: generate, install, rootCA |
| `dns/` | DNS configuration (`dnsConfig.js`) |
| `handlers/` | Per-tool handlers: antigravity, copilot, cursor, kiro (+ `base.js`) |

## For AI Agents

### Working In This Directory
- New intercepted tool gets a new file in `handlers/` following `base.js` patterns.
- Cert install is platform-specific; keep `winElevated.js` behavior intact.

### Testing Requirements
- Handler changes need a vitest suite under `tests/`, run from repo root.

## Dependencies

### Internal
- `../lib/db/` — intercepted traffic persistence
- `../../open-sse/` — upstream dispatch for intercepted requests

<!-- MANUAL: -->
