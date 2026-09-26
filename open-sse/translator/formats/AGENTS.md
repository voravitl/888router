<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# formats

## Purpose
Per-format translator modules backing `translator/formats.js`: Claude, Gemini, OpenAI, Responses API, and max-tokens handling.

## Key Files
| File | Description |
|------|-------------|
| `claude.js` | Claude format module |
| `gemini.js` | Gemini format module |
| `openai.js` | OpenAI format module |
| `responsesApi.js` | Responses API format module |
| `maxTokens.js` | Max-tokens normalization |

## For AI Agents

### Working In This Directory
- Format-wide behavior (e.g. max-tokens clamping) goes here; pair-specific quirks go in `request/` or `response/`.

## Dependencies

### Internal
- `../concerns/` — shared parsers used by format modules

<!-- MANUAL: -->
