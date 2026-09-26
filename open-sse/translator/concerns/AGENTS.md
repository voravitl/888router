<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# concerns

## Purpose
Shared translation logic reused by request/response translators so parsing is implemented once.

## Key Files
| File | Description |
|------|-------------|
| `toolCall.js` | Tool-call parse/build (+ `universalToolParser.js`, `universalToolPrompt.js`, `toolArgs.js`) |
| `thinking.js` | Thinking-block handling (+ `thinkingUnified.js`, `reasoning.js`) |
| `message.js` | Message normalization (+ `historyAdapter.js`) |
| `image.js` | Image block handling |
| `usage.js` | Usage accounting |
| `json.js` | JSON helpers (+ `jsonAutoRepair.js`) |
| `chunk.js` | Chunk helpers |
| `finishReason.js` | Finish-reason mapping |
| `intentRouter.js` | Intent routing |
| `modality.js` | Modality detection |
| `paramSupport.js` | Parameter support matrix |
| `prefetch.js` | Prefetch helper |
| `promptCache.js` | Prompt-cache handling |
| `pruner.js` | Context pruning |
| `responseCache.js` | Response cache |
| `kiroConversation.js` | Kiro conversation shaping |
| `astSummarizer.js` | AST summarizer |

## For AI Agents

### Working In This Directory
- Fix shared parsing here, not by forking logic into one translator — every pair benefits.
- Thinking-tag streams split across SSE chunk boundaries need the stateful processor, not a stateless regex.

## Dependencies

### Internal
- `../schema/` — enums consumed by these helpers

<!-- MANUAL: -->
