<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# sse

## Purpose
App-side gateway entry glue: `/v1` route handlers parse requests, run combo expansion and the account-selection loop, then delegate engine work to `open-sse/`.

## Key Files
| File | Description |
|------|-------------|
| `handlers/chat.js` | Chat entry: parse, combo expansion, account loop |
| `handlers/embeddings.js` | Embeddings entry |
| `handlers/imageGeneration.js` | Image generation entry |
| `handlers/search.js` | Search entry |
| `handlers/stt.js` | Speech-to-text entry |
| `handlers/tts.js` | Text-to-speech entry |
| `handlers/videoGeneration.js` | Video generation entry |
| `handlers/fetch.js` | Fetch-tool entry |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `handlers/` | Per-modality entry handlers (see table above) |
| `services/` | Entry services: auth, model resolution, token refresh |
| `utils/` | Entry logger helper |

## For AI Agents

### Working In This Directory
- Keep handlers thin: parse and select account here, translate and stream in `open-sse/`.
- Cross the `src/sse` into `open-sse` boundary consciously; provider logic belongs in the engine, not here.

### Testing Requirements
- Handler changes need a vitest suite under `tests/`, run from repo root.

### Common Patterns
- `handlers/chat.js` owns the combo/account retry loop; `open-sse/handlers/chatCore.js` owns the single-attempt stream.

## Dependencies

### Internal
- `../../../open-sse/` — routing/translation engine
- `../lib/` — auth, DB repos, OAuth

<!-- MANUAL: -->
