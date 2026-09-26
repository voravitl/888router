<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# app

## Purpose
Next.js App Router entry: public landing/login pages, `(dashboard)` route group, `ext` OAuth-callback helpers, and the full `/api` backend (dashboard features + OpenAI-compatible `/v1` gateway).

## Key Files
| File | Description |
|------|-------------|
| `layout.js` | Root layout (theme, i18n provider) |
| `page.js` | Landing entry |
| `globals.css` | Global styles |
| `manifest.js` | PWA manifest |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `api/` | Backend routes: dashboard features + `/v1`, `/v1beta` compat gateway, `version`, `health` |
| `(dashboard)/` | Authenticated dashboard route group |
| `dashboard/` | Dashboard pages (settings, providers, models) |
| `landing/` | Public landing page + components |
| `login/` | Login page |
| `callback/` | OAuth callback handler |
| `ext/` | Extension/chunk/loader/status/quota helper pages |

### `api/` routes
`aipass-extension, auth, cli-tools, combos, dashboard, headroom, health, init, keys, locale, mcp, media-providers, models, oauth, pricing, provider-nodes, providers, proxy-pools, settings, shutdown, skills, tags, translator, tunnel, usage, v1, v1beta, version`

## For AI Agents

### Working In This Directory
- `/v1/*` routes are the compat gateway — parse + combo/account loop in `src/sse/handlers/chat.js`, engine work in `open-sse/`. Touch `app/api/v1` only for routing/auth concerns.
- Dashboard feature routes (`providers`, `models`, `combos`, `settings`) read/write via `src/lib/db/` repos, never raw SQL.
- Next rewrite maps `/v1/*` → `/api/v1/*` in `next.config.mjs`.

### Testing Requirements
- API changes: add/extend a vitest suite under `tests/`; run from repo root.

### Common Patterns
- Route handlers are thin: validate input → call `src/lib/` or `src/sse/` service → return JSON/SSE.

## Dependencies

### Internal
- `../lib/` — DB repos, auth, OAuth
- `../sse/` — gateway entry glue
- `../../../open-sse/` — routing/translation engine

### External
- Next.js App Router (`route.js` conventions)

<!-- MANUAL: -->
