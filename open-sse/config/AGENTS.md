<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# config

## Purpose
Single source of truth for ALL constants and configuration. Nothing outside this directory hardcodes provider defs, model lists, timeouts, or limits.

## Key Files
| File | Description |
|------|-------------|
| `providers.js` | Provider definitions entry |
| `providerModels.js` | Alias-to-models matrix |
| `models.js` | Model catalog constants |
| `runtimeConfig.js` | Timeouts, token limits |
| `constants.js` | Shared constants |
| `appConstants.js` | App-level constants |
| `errorConfig.js` | Error classification config |
| `mediaConfig.js` | Image/TTS/media config |
| `freeModelCatalog.js` | Free-tier model catalog (+ `.data.js`) |
| `ollamaModels.js` | Ollama local model list |
| `ttsModels.js` | TTS model list |
| `googleTtsLanguages.js` | Google TTS language table |
| `kiroConstants.js` | Kiro-specific constants |
| `grokCli.js` | Grok CLI config |
| `codexInstructions.js` | Codex instruction presets |
| `defaultThinkingSignature.js` | Default thinking-block signature |
| `retiredProviders.js` | Retired provider tombstones |

## For AI Agents

### Working In This Directory
- Add a provider: copy `providers/REGISTRY_TEMPLATE.js` to `providers/registry/{id}.js`, then add its models here in `providerModels.js`.
- Never hardcode a model name, URL, or limit in engine code — add it here and import it.
- `providers/registry/index.js` is auto-generated; regenerate via `scripts/migrate-registry.mjs`, do not hand-edit.

### Testing Requirements
- Config changes verified via `tests/__baseline__/verify-no-regression.mjs` (providers, aliases, OAuth URLs) run from repo root.

## Dependencies

### Internal
- `../providers/registry/` — per-provider definition files consumed here

<!-- MANUAL: -->
