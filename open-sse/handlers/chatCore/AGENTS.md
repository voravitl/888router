<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# chatCore

## Purpose
Single-attempt chat stream pipeline. The combo and account retry loop lives outside, in `src/sse/handlers/chat.js` and `services/combo.js`.

## Key Files
| File | Description |
|------|-------------|
| `streamingHandler.js` | Streaming chat core (SSE out) |
| `nonStreamingHandler.js` | Non-streaming chat core |
| `sseToJsonHandler.js` | SSE-to-JSON conversion core |
| `requestDetail.js` | Request detail capture |

## For AI Agents

### Working In This Directory
- Preserve SSE framing and tool-call accumulation; verify against the live endpoint, not just unit tests.
- Retry and fallback belong one layer up — keep this single-attempt.

## Dependencies

### Internal
- `../../services/` — model, provider, combo, token refresh
- `../../translator/` — format conversion around the stream

<!-- MANUAL: -->
