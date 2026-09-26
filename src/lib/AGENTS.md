<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# lib

## Purpose
Server-side libraries: SQLite persistence, auth/session, OAuth providers, network tunnel, app updater, MCP, headroom proxy, and logging. New code imports DB via `@/lib/db/index.js`.

## Key Files
| File | Description |
|------|-------------|
| `localDb.js` | Backward-compat shim re-exporting `db/index.js` (do not extend) |
| `usageDb.js` | Usage/quota log store under `~/.9router` |
| `dataDir.js` | Data-dir resolution (`DATA_DIR` else `~/.9router/`) |
| `providerNormalization.js` | Provider name/model normalization |
| `upstreamErrorDetail.js` | Upstream error classification |
| `apiLogger.js` | Request logging |
| `consoleLogBuffer.js` | In-memory console log buffer |
| `appUpdater.js` | App update checker |
| `cloudflareAiModels.js` | Cloudflare AI model list |
| `disabledModelsDb.js` | Disabled-models store |
| `requestDetailsDb.js` | Request detail store |
| `extCors.js` | Extension CORS helper |
| `mitmAliasCache.js` | MITM alias cache |
| `route-manifest.js` | Route manifest helper |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `db/` | SQLite layer: driver fallback chain, repos, migrations (see `db/AGENTS.md`) |
| `auth/` | Session/JWT auth, login limiter, OIDC/SAML, trusted peer |
| `oauth/` | OAuth providers, services, utils, constants |
| `network/` | Network helpers |
| `tunnel/` | Tunnel clients: cloudflare, tailscale, shared |
| `updater/` | Auto-updater logic |
| `mcp/` | MCP server integration |
| `headroom/` | Headroom proxy client |
| `qoder/` | Qoder provider helpers |

## For AI Agents

### Working In This Directory
- SQLite adapter fallback: `bun:sqlite` → `better-sqlite3` (optional) → `node:sqlite` (Node 22.5+) → `sql.js` (always works). Keep `better-sqlite3` optional so install never fails.
- Per-entity logic lives in `db/repos/*`; schema/migrations in `db/migrations/`.
- `usage.json` + `log.txt` stay under `~/.9router`, do not follow `DATA_DIR`.

### Testing Requirements
- DB changes need a migration in `db/migrations/` plus a repo test under `tests/`.

### Common Patterns
- Repos expose CRUD per entity; route handlers call repos, never raw SQL.

## Dependencies

### Internal
- `db/paths.js` — DB file location resolution

### External
- `better-sqlite3` (optional), `node:sqlite`, `sql.js`

<!-- MANUAL: -->
