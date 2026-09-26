<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# store

## Purpose
Client-side state stores (Zustand-style): settings, providers, theme, user, notifications, and header search.

## Key Files
| File | Description |
|------|-------------|
| `index.js` | Store barrel / combined export |
| `settingsStore.js` | App settings state |
| `providerStore.js` | Provider connections state |
| `themeStore.js` | Theme (light/dark) state |
| `userStore.js` | Session user state |
| `notificationStore.js` | Toast/notification queue |
| `headerSearchStore.js` | Header search input state |

## For AI Agents

### Working In This Directory
- New global client state gets its own `*Store.js` plus an export in `index.js`.
- Keep stores UI-only; server truth lives in `../lib/db/` and is fetched via `../shared/utils/api.js`.

### Testing Requirements
- Store logic covered by vitest from repo root where non-trivial.

## Dependencies

### Internal
- `../shared/utils/api.js` — server fetch layer used by stores

### External
- Zustand

<!-- MANUAL: -->
