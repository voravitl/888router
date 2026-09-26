<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# translator

## Purpose
Client-format to provider-format conversion. Pivots through OpenAI as the intermediate format; exact `source:target` pairs run as direct routes skipping the lossy double-hop.

## Key Files
| File | Description |
|------|-------------|
| `index.js` | Registry entry: `register(from, to, reqFn, resFn)`, `translateRequest`, `translateResponse` |
| `formats.js` | Per-format dispatcher |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `request/` | Request translators: claude/gemini/antigravity-to-openai, openai-to-claude/gemini/kiro/cursor/ollama/vertex/commandcode, openai-responses |
| `response/` | Response translators: *-to-openai, openai-to-claude/antigravity, kiro-to-claude, openai-responses |
| `schema/` | Enums and constants: ROLE, CLAUDE_BLOCK, model markers |
| `concerns/` | Shared logic: toolCall, thinking, reasoning, message, image, usage, json repair, promptCache, paramSupport |
| `formats/` | Per-format modules: claude, gemini, openai, responsesApi, maxTokens |

## For AI Agents

### Working In This Directory
- New translator MUST self-register via `register(from, to, reqFn, resFn)` as an import side effect AND be imported in `index.js`, or it never runs.
- Reuse `schema/` and `concerns/` — never re-implement message/tool/thinking parsing.
- OpenAI bridge is lossy (thinking blocks, non-base64 images, tool ids, `is_error`) — prefer a direct route for fragile pairs.
- Equality in ES|QL-style filters is out of scope here; this is JS format translation, not query language.

### Testing Requirements
- Translator changes need a vitest suite under `tests/translator/` (see its `AGENTS.md`), run from repo root.

### Common Patterns
- File naming: `request/<from>-to-<to>.js`, `response/<from>-to-<to>.js`.

## Dependencies

### Internal
- `../config/` — provider/model constants (never hardcode)
- `../schema/` — block/role enums

<!-- MANUAL: -->
