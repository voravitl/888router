<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# i18n

## Purpose
Internationalization runtime: locale config, runtime loader, and React provider for dashboard translations.

## Key Files
| File | Description |
|------|-------------|
| `config.js` | Supported locales and defaults |
| `runtime.js` | Runtime message loader |
| `RuntimeI18nProvider.js` | React provider component |

## For AI Agents

### Working In This Directory
- New locale strings go through `config.js` locale list plus `public/i18n/` message files.
- Keep `RuntimeI18nProvider.js` as the single provider mount (already wired in `app/layout.js`).

### Testing Requirements
- Locale changes verified by loading the dashboard in the target language.

## Dependencies

### Internal
- `../../public/i18n/` — message catalogs
- `../shared/constants/locales.js` — locale table

<!-- MANUAL: -->
