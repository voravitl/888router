<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# utils

## Purpose
Engine utilities: stream/SSE plumbing, error shaping, session management, client detection, fetch patching, Claude cloaking, tool dedup/caps, usage tracking, and binary-format helpers (cursor protobuf, ollama transform).

## Key Files
| File | Description |
|------|-------------|
| `streamHandler.js` | Stream orchestration |
| `stream.js` | Stream primitives (+ `streamHelpers.js`) |
| `sse.js` | SSE framing (+ `sseConstants.js`) |
| `error.js` | Error shaping |
| `sessionManager.js` | Session lifecycle |
| `clientDetector.js` | Client identification |
| `proxyFetch.js` | Global fetch patch |
| `claudeCloaking.js` | Claude request cloaking (+ `claudeSignature.js`, `claudeHeaderCache.js`) |
| `toolDeduper.js` | Tool-call dedup |
| `toolCap.js` | Tool capability caps |
| `usageTracking.js` | Usage accounting |
| `requestLogger.js` | Request logging (+ `debugLog.js`) |
| `cursorProtobuf.js` | Cursor protobuf codec (+ `cursorChecksum.js`) |
| `ollamaTransform.js` | Ollama NDJSON transform (streams `x-ndjson`, not SSE) |
| `opencodeToolSanitizer.js` | Opencode tool sanitizer |
| `reasoningContentInjector.js` | Reasoning-content injection |
| `responsesStreamHelpers.js` | Responses-API stream helpers |
| `kiroSessionReplay.js` | Kiro session replay |
| `modelMarkers.js` | Model markers |
| `bypassHandler.js` | Bypass handler |

## For AI Agents

### Working In This Directory
- Stream framing changes affect every provider — test broadly, not just one executor.
- `proxyFetch.js` patches global fetch; keep its scope narrow to avoid side effects.
- Ollama targets stream `x-ndjson`, not SSE — the streaming gate must allow it for ollama only.

### Testing Requirements
- Util changes need a vitest suite under `tests/`, run from repo root.

## Dependencies

### Internal
- `../handlers/` — primary consumers of stream/SSE utils
- `../config/` — error and SSE constants

<!-- MANUAL: -->
