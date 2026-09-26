<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# oauth

## Purpose
OAuth flows for tool providers (Claude, Gemini, Cursor, Kiro, Codex, Qwen, and others): provider clients, shared service, PKCE helpers, and constants.

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `providers/` | Per-tool OAuth clients (grok-cli, trae, windsurf, zed, ...) |
| `services/` | Shared OAuth service (`oauth.js`, `index.js`) plus per-tool flows (antigravity, claude, gemini, cursor, kiro, codex, ...) |
| `utils/` | PKCE, local callback server, banner, UI helpers |
| `constants/` | OAuth and xAI constants |

## For AI Agents

### Working In This Directory
- New OAuth tool means a client in `providers/` plus a flow in `services/`; reuse PKCE and callback server in `utils/`.
- Never log tokens, codes, or verifiers; keep credential persistence in `open-sse/services/oauthCredentialManager.js`.

### Testing Requirements
- OAuth changes need mocked-credential vitest suites; the live flow is verified manually, never in CI.

## Dependencies

### Internal
- `../../../open-sse/services/oauthCredentialManager.js` — credential lifecycle

<!-- MANUAL: -->
