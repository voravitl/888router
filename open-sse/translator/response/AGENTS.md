<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# response

## Purpose
Response-direction translators (provider chunks to client format). Hot path includes `kiro-to-claude.js`; every chunk preserves tool-call identity for stream accumulation.

## Key Files
| File | Description |
|------|-------------|
| `kiro-to-claude.js` | Kiro chunks to Claude (hot path) |
| `kiro-to-openai.js` | Kiro chunks to OpenAI |
| `claude-to-openai.js` | Claude to OpenAI chunks |
| `gemini-to-openai.js` | Gemini to OpenAI chunks |
| `cursor-to-openai.js` | Cursor to OpenAI chunks |
| `commandcode-to-openai.js` | CommandCode to OpenAI chunks |
| `ollama-to-openai.js` | Ollama NDJSON to OpenAI chunks |
| `openai-to-claude.js` | OpenAI to Claude chunks |
| `openai-to-antigravity.js` | OpenAI to Antigravity chunks |
| `openai-responses.js` | OpenAI Responses API response shape |

## For AI Agents

### Working In This Directory
- Preserve tool-call ids across chunks; a dropped id breaks accumulation in `chatCore/streamingHandler.js`.
- New file MUST be imported in `translator/index.js` or it never runs.

<!-- MANUAL: -->
