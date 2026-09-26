<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# executors

## Purpose
Per-provider upstream call layer. `base.js` defines `BaseExecutor`; one file per non-standard provider; `default.js` handles any OpenAI-compatible API; `index.js` maps provider id to executor with `DefaultExecutor` fallback.

## Key Files
| File | Description |
|------|-------------|
| `base.js` | `BaseExecutor` base class (`getBaseUrls`, `buildHeaders`, `buildUrl`, `execute`) |
| `default.js` | `DefaultExecutor` for OpenAI-compatible upstreams |
| `index.js` | Executor map + `getExecutor(provider)` with fallback |
| `kiro.js` | Kiro EventStream executor (binary, no OpenAI round-trip) |
| `cursor.js` | Cursor protobuf executor |
| `commandcode.js` | CommandCode NDJSON executor |
| `antigravity.js` | Antigravity executor |
| `codex.js` | Codex executor |
| `vertex.js` | Vertex AI executor |
| `azure.js` | Azure OpenAI executor |

## For AI Agents

### Working In This Directory
- New executor only for non-OpenAI-compatible upstreams: subclass `BaseExecutor`, override URL/header/build methods, register in `index.js`.
- Generic providers need no executor — `DefaultExecutor` covers them.
- Binary/protobuf upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) stay inside their executor; never route through the translator OpenAI bridge.

### Testing Requirements
- Executor changes need a vitest suite under `tests/` (mock upstream), run from repo root.

## Dependencies

### Internal
- `../translator/` — request/response translation around execution
- `../config/` — endpoints, keys, limits

<!-- MANUAL: -->
