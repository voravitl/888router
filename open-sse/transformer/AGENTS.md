<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# transformer

## Purpose
Stream-shape converters between API styles: Chat Completions SSE to Codex Responses API SSE, generic stream-to-JSON, and tool-call shims.

## Key Files
| File | Description |
|------|-------------|
| `responsesTransformer.js` | Chat Completions SSE to Codex Responses API SSE |
| `streamToJsonConverter.js` | Stream-to-JSON converter |
| `streamToolShim.js` | Streaming tool-call shim |

## For AI Agents

### Working In This Directory
- Preserve event ordering and tool-call identity across conversion; a dropped id breaks accumulation downstream.
- Keep converters pure (no network, no state beyond the stream).

### Testing Requirements
- Converter changes need a vitest suite under `tests/`, run from repo root.

## Dependencies

### Internal
- `../translator/` — format definitions consumed during conversion
- `../utils/` — stream/SSE primitives

<!-- MANUAL: -->
