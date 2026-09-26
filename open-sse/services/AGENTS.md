<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# services

## Purpose
Engine services: model/provider resolution, combo and account fallback, OAuth credential management, token refresh, usage tracking, quota snapshots, and per-tool model-list helpers.

## Key Files
| File | Description |
|------|-------------|
| `model.js` | `parseModel`: resolves `provider/model` |
| `provider.js` | Provider resolution |
| `combo.js` | Combo expansion and failover |
| `accountFallback.js` | Multi-account fallback |
| `accountScoring.js` | Account scoring for selection |
| `oauthCredentialManager.js` | OAuth credential lifecycle |
| `tokenRefresh.js` | Token refresh entry (+ `tokenRefresh/` subdir) |
| `usage.js` | Usage tracking entry (+ `usage/` subdir) |
| `quotaSnapshot.js` | Quota snapshot capture |
| `requestLogger.js` | Request logging |
| `capacityAdapter.js` | Capacity adaptation |
| `comboStreamGuard.js` | Combo stream guard |
| `compact.js` | Context compaction |
| `healthStore.js` | Provider health store |
| `modalityBridge.js` | Cross-modality bridge |
| `modelsDevModality.js` | models.dev modality mapping |
| `projectId.js` | Project-id resolution |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `autoCombo/` | Automatic combo selection |
| `mcp/` | MCP service integration |
| `tokenRefresh/` | Per-provider token refresh |
| `usage/` | Usage aggregation |

## For AI Agents

### Working In This Directory
- `combo.js` failover and 429/quota handling are hot paths — verify against the live pod log, not just unit tests.
- `*Models.js` helpers (kiro, qoder, copilot, clinepass, grokCli, opencodeGo, kimchi) feed model lists; capability precedence is `DEFAULT < catalogue < dynamic < provider`.

### Testing Requirements
- Service changes need a vitest suite under `tests/`, run from repo root.

## Dependencies

### Internal
- `../config/` — models, providers, runtime limits
- `../../src/lib/db/` — persisted usage, quota, credentials

<!-- MANUAL: -->
