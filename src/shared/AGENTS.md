<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# shared

## Purpose
Shared client code: reusable UI components (mostly modals), constant tables, React hooks, app-init services, and frontend utils (API client, SSRF guard, model search).

## Key Files
| File | Description |
|------|-------------|
| `skillRefs.js` | Skill reference registry |
| `skillsDir.js` | Skills directory resolution |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `components/` | Reusable UI: Button, Modal, Sidebar, Header, 30+ modals (OAuth, provider setup, combo form); `layouts/` subdir; barrel `index.js` |
| `constants/` | Tables: providers, models, locales, colors, skills, TTS providers, CLI tools, MITM hosts |
| `hooks/` | React hooks: theme, clipboard, model caps, context windows |
| `services/` | App init: bootstrap, initializeApp, quotaAutoPing |
| `utils/` | Frontend utils: api client, apiKey, ssrfGuard, modelSearch, contextWindow, providerModelsFetcher |

## For AI Agents

### Working In This Directory
- New modal goes in `components/` and exports via `index.js` barrel.
- Constants are the single source of truth — never duplicate provider/model tables inline.
- `ssrfGuard.js` guards outbound URLs; preserve its checks when touching fetch paths.

### Testing Requirements
- UI changes verified in the running dashboard; logic utils covered by vitest from repo root.

## Dependencies

### Internal
- `../store/` — client state consumed by components
- `../i18n/` — locale strings

### External
- React 19, Tailwind CSS

<!-- MANUAL: -->
