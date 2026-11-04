<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# public

## Purpose
Static assets served by Next.js: provider logos, app icons, i18n literals.

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `providers/` | Per-provider logo PNGs (matches `open-sse/providers/registry/` ids) |
| `icons/` | App icons (`icon-192.svg`, `icon-512.svg`) |
| `i18n/literals/` | Static i18n literal files |

## For AI Agents

### Working In This Directory
- New provider needs a logo here matching its registry id; generate via `scripts/generate_provider_logos.py`.
- Never put secrets or dynamic data in `public/` — everything here is served verbatim.

## Dependencies

### Internal
- `../scripts/generate_provider_logos.py` — logo generation

<!-- MANUAL: -->
