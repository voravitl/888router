<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# request

## Purpose
Request-direction translators (client format to provider format). Files named `<from>-to-<to>.js`, each calling `register()` as an import side effect.

## Key Files
| File | Description |
|------|-------------|
| `claude-to-openai.js` | Claude messages to OpenAI chat |
| `claude-to-kiro.js` | Claude direct to Kiro (fragile-pair direct route) |
| `gemini-to-openai.js` | Gemini to OpenAI chat |
| `antigravity-to-openai.js` | Antigravity to OpenAI chat |
| `openai-to-claude.js` | OpenAI to Claude messages |
| `openai-to-gemini.js` | OpenAI to Gemini |
| `openai-to-kiro.js` | OpenAI to Kiro |
| `openai-to-cursor.js` | OpenAI to Cursor |
| `openai-to-ollama.js` | OpenAI to Ollama |
| `openai-to-vertex.js` | OpenAI to Vertex |
| `openai-to-commandcode.js` | OpenAI to CommandCode |
| `openai-responses.js` | OpenAI Responses API request shape |

## For AI Agents

### Working In This Directory
- New file MUST be imported in `translator/index.js` or it never runs.
- Reuse `schema/` enums and `concerns/` parsers; never hardcode roles or block strings.

<!-- MANUAL: -->
