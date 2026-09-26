<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# src

## Purpose
Next.js application source: dashboard UI, `/api` routes, SQLite persistence layer, app-side SSE entry glue, and MITM proxy helpers. Path alias `@/*` maps to `src/*`.

## Key Files
| File | Description |
|------|-------------|
| `proxy.js` | Reverse-proxy helper for upstream forwarding |
| `dashboardGuard.js` | Dashboard route access guard |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `app/` | App Router pages + API routes (see `app/AGENTS.md`) |
| `lib/` | Server libs: auth, SQLite DB, OAuth, tunnel, updater (see `lib/AGENTS.md`) |
| `sse/` | App-side SSE handlers/services, delegates to `open-sse/` engine (see `sse/AGENTS.md`) |
| `mitm/` | Local MITM proxy: cert, DNS, handlers (see `mitm/AGENTS.md`) |
| `shared/` | Shared UI components, constants, hooks, services, utils (see `shared/AGENTS.md`) |
| `models/` | Client-side model catalog (`index.js`) |
| `store/` | Zustand-style client stores (settings, provider, theme, user) |
| `i18n/` | Runtime i18n config and provider |

## For AI Agents

### Working In This Directory
- Plain JavaScript (ESM), no TypeScript. camelCase, config-driven — never hardcode model/role strings.
- `src/lib/localDb.js` is a backward-compat shim re-exporting `src/lib/db/index.js`; new code imports from `@/lib/db/index.js`.
- `custom-server.js` (repo root) strips attacker-controlled `X-Forwarded-For` — preserve when touching request/IP/rate-limit code.

### Testing Requirements
- Run from repo root: `npx vitest run --config tests/vitest.config.js` (running from `tests/` breaks `path.resolve("src/...")` suites).

### Common Patterns
- API routes under `app/api/` map to dashboard features; `/v1/*` compat routes delegate to `src/sse/` then `open-sse/`.

## Dependencies

### Internal
- `open-sse/` — provider-agnostic routing/translation engine (see `../open-sse/AGENTS.md`)

### External
- Next.js 15 (App Router), React 19

<!-- MANUAL: -->
