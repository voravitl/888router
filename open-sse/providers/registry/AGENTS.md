<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# registry

## Purpose
One definition file per provider (~130: anthropic, openai, gemini, etc). `index.js` is auto-generated — never hand-edit.

## Key Files
| File | Description |
|------|-------------|
| `index.js` | Auto-generated static import list (via `scripts/migrate-registry.mjs`) |

## For AI Agents

### Working In This Directory
- New provider: copy `../REGISTRY_TEMPLATE.js` to `{id}.js`, add models to `config/providerModels.js`, run `scripts/migrate-registry.mjs`.
- Capability claims need evidence (models.dev, provider docs, observed error).

## Dependencies

### Internal
- `../../config/providerModels.js` — alias-to-models matrix

<!-- MANUAL: -->
