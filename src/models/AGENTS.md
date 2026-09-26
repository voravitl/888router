<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# models

## Purpose
Client-side model catalog (`index.js`): static model lists consumed by dashboard selectors before dynamic sync replaces them.

## Key Files
| File | Description |
|------|-------------|
| `index.js` | Static model catalog entry |

## For AI Agents

### Working In This Directory
- Dynamic capability sync (`/v1/models` reads synced caps) is the source of truth at runtime; edit this catalog only for static fallbacks.
- Evidence before edit: cite `models.dev` API or an observed upstream error for any capability claim.

### Testing Requirements
- Catalog changes verified via `tests/__baseline__/verify-no-regression.mjs` after touching provider/model logic.

## Dependencies

### Internal
- `../shared/constants/models.js` — canonical model tables
- `../../../open-sse/config/providerModels.js` — alias-to-models matrix

<!-- MANUAL: -->
