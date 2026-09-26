<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# models

## Purpose
Model-name helpers for the provider registry: schema, name patterns, and shared resolution helpers.

## Key Files
| File | Description |
|------|-------------|
| `schema.js` | Model entry schema |
| `namePatterns.js` | Model-name matching patterns |
| `helpers.js` | Shared resolution helpers |

## For AI Agents

### Working In This Directory
- Keep patterns tight — a loose wildcard can fabricate context limits for unknown models (see Ollama `num_ctx` guardrail in `open-sse/AGENTS.md`).

## Dependencies

### Internal
- `../registry/` — consumers of these helpers

<!-- MANUAL: -->
