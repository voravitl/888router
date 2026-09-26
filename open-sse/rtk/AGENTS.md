<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# rtk

## Purpose
Request Token Killer: pre-translate hooks that compress `tool_result` content in place to cut tokens. Fail-open — any error returns null and leaves the body untouched.

## Key Files
| File | Description |
|------|-------------|
| `index.js` | Main `tool_result` compressor (OpenAI/Claude/Kiro shapes) |
| `applyFilter.js` | Filter application entry |
| `autodetect.js` | Tool-type autodetection |
| `registry.js` | Filter registry |
| `headroom.js` | External compress-proxy client |
| `caveman.js` | System-prompt injector (+ `cavemanPrompts.js`) |
| `ponytail.js` | Ponytail compressor (+ `ponytailPrompt.js`) |
| `systemInject.js` | System-prompt injection |
| `constants.js` | RTK constants |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `filters/` | Per-tool compressors: read, grep, ls, tree, find, git log/diff/status, build output, dedupLog, searchList, smartTruncate |

## For AI Agents

### Working In This Directory
- Never throw out of a hook — return null on error (fail-open invariant).
- Skips `is_error` / `status:"error"` tool results to preserve error traces.
- New compressor goes in `filters/` plus registration in `registry.js`.

### Testing Requirements
- Filter changes need a vitest suite under `tests/`, run from repo root.

## Dependencies

### Internal
- `../translator/` — runs before translation in the chat pipeline

<!-- MANUAL: -->
