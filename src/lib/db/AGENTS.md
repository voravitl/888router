<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# db

## Purpose
SQLite persistence layer with adapter fallback chain, per-entity repos, migrations, and path resolution.

## Key Files
| File | Description |
|------|-------------|
| `index.js` | Public entry — new code imports `@/lib/db/index.js` |
| `driver.js` | Adapter fallback: bun:sqlite, better-sqlite3, node:sqlite, sql.js |
| `schema.js` | Schema definitions |
| `migrate.js` | Migration runner |
| `paths.js` | DB file location (`DATA_DIR` else `~/.9router/`) |
| `backup.js` | Backup helper |
| `version.js` | Schema version |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `repos/` | Per-entity CRUD: settings, combos, connections, apiKeys, nodes, pricing, proxyPools, usage, aliases, syncedModels, disabledModels, requestDetails |
| `migrations/` | Schema migrations (`001-initial.js`, runner `index.js`) |
| `adapters/` | Driver adapters: bun, better-sqlite3, node:sqlite, sql.js |
| `helpers/` | Shared helpers: jsonCol, kvStore, metaStore |

## For AI Agents

### Working In This Directory
- Never raw SQL from route handlers — add or extend a repo in `repos/`.
- Schema change means new migration plus `schema.js` update plus repo test.
- `better-sqlite3` stays optional; never require a native build at install.

### Testing Requirements
- Repo and migration changes need a vitest suite under `tests/`, run from repo root.

## Dependencies

### External
- `better-sqlite3` (optional), `node:sqlite` (Node 22.5+), `sql.js` (fallback)

<!-- MANUAL: -->
