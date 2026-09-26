<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# providers

## Purpose
Provider registry build: ~130 per-provider definition files plus capabilities, pricing, and model-name helpers. Entry is `index.js` (`PROVIDERS`).

## Key Files
| File | Description |
|------|-------------|
| `index.js` | Registry entry exporting `PROVIDERS` |
| `capabilities.js` | Capability resolution per model |
| `pricing.js` | Pricing tables |
| `REGISTRY_TEMPLATE.js` | Template for new providers (excluded from auto-import by design) |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `registry/` | One file per provider (`anthropic.js`, `openai.js`, `gemini.js`, ...); `index.js` is auto-generated |
| `models/` | Model-name helpers: `schema.js`, `namePatterns.js`, `helpers.js` |

## For AI Agents

### Working In This Directory
- Add a provider: copy `REGISTRY_TEMPLATE.js` to `registry/{id}.js`, add models to `config/providerModels.js`, regenerate `registry/index.js` (never hand-edit it).
- Capability claims need evidence (`models.dev` API, provider docs, observed error) — see root delivery rules.
- Capability precedence is `DEFAULT < catalogue < dynamic < provider`; a provider override must outrank a live sync.

### Testing Requirements
- Registry changes verified via `tests/__baseline__/verify-no-regression.mjs` (providers, aliases) run from repo root.

## Dependencies

### Internal
- `../config/` — canonical constants consumed by registry files

<!-- MANUAL: -->
