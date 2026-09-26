<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# handlers

## Purpose
Per-modality engine cores: chat (streaming, non-streaming, SSE-to-JSON), embeddings, images, TTS, STT, search, fetch. `chatCore/` holds the single-attempt stream pipeline; the combo/account retry loop lives in `src/sse/handlers/chat.js`.

## Key Files
| File | Description |
|------|-------------|
| `chatCore/nonStreamingHandler.js` | Non-streaming chat core |
| `chatCore/streamingHandler.js` | Streaming chat core (SSE out) |
| `chatCore/sseToJsonHandler.js` | SSE-to-JSON conversion core |
| `chatCore/requestDetail.js` | Request detail capture |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `chatCore/` | Chat streaming/non-streaming cores (see table above) |
| `embeddingProviders/` | Embedding provider handlers |
| `imageProviders/` | Image provider handlers |
| `ttsProviders/` | TTS provider handlers |
| `search/` | Search handlers |
| `fetch/` | Fetch-tool handlers |

## For AI Agents

### Working In This Directory
- Single-attempt logic here; multi-account/combo fallback stays in `src/sse/` and `services/combo.js`.
- Preserve SSE framing and tool-call accumulation behavior; verify against live endpoint, not just unit tests.

### Testing Requirements
- Handler changes need a vitest suite under `tests/`, run from repo root.

## Dependencies

### Internal
- `../services/` — model, provider, combo, token refresh
- `../translator/` — format conversion around the stream
- `../executors/` — upstream dispatch

<!-- MANUAL: -->
