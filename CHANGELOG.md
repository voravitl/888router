# v0.15.58 (2026-08-28)

## Fix: `console.log` → `console.error` in `models/route.js` (PR #336, closes #330)

Two `catch` blocks in `src/app/api/models/route.js` (lines 33, 64) logged caught exceptions via `console.log`, making production error tracking indistinguishable from info-level output. Now writes to `stderr` so monitoring tooling can separate errors from informational logs.

## Fix: `suggested-models` `openai` filter + private-provider bearer auth (PR #337, closes #319)

- **`openai` filter added** to `src/app/api/providers/suggested-models/filters.js` — parses `{ data: [{ id, ... }] }` into `{ id, name, contextLength }`. Handles `context_length` / `contextWindow` / `maxInputTokens` variants, guards against non-numeric values producing NaN, skips null entries.
- **Optional `X-Provider-Key` header** on `/api/providers/suggested-models` — when provided, the route forwards it as `Authorization: Bearer <key>` to the upstream `/v1/models` so private OpenAI-compatible providers (B.AI, GMI, Venice, Vercel AI Gateway, Perplexity, NousResearch, Tokenrouter) can sync.
- **Cache key includes an FNV-1a hash of the API key** so two connections on the same provider URL never share cached results across users.
- **Provider detail page** (`src/app/(dashboard)/dashboard/providers/[id]/page.js`) passes the active connection's `apiKey` to the fetcher when one exists.
- **Regression test** at `tests/unit/suggested-models-openai-filter.test.js` — 7 cases: filter shape, context-length extraction, null guard, route auth header with/without key, unknown-type 400, cache-key hash distinctness.

## CLI: 0.5.22

Independent version bump for the `9router` npm package (CLI launcher). Root dashboard version remains independent of CLI version per repo convention.

# v0.15.57 (2026-08-28)

## Revert: Drop DuckDuckGo v0.15.56 Model Additions (PR #333)

DuckDuckGo changed its VQD handshake protocol. The 5 new models from v0.15.56 are kept in the registry with a `notice.text` explaining the situation; re-enable when a VQD executor ships. See issue #338.

# v0.15.56 (2026-08-28)

## Fix: DuckDuckGo Models Catalogue, Context Lengths, and Dynamic Sync

- **5 new DuckDuckGo AI Chat models** added to `open-sse/providers/registry/duckduckgo-web.js` with verified context lengths: `gpt-4o-mini` (128k), `claude-3-haiku-20240307` (200k), `meta-llama/Llama-3.3-70B-Instruct-Turbo` (128k), `mistralai/Mistral-Small-24B-Instruct-2501` (32k), `o3-mini` (200k).
- **Free model catalog** synced with the 5 new entries (`open-sse/config/freeModelCatalog.data.js`).
- **Provider detail page dynamic fetch** now hits `/api/providers/<providerId>/models` for public-keyless providers even when no connection row exists, gated by `isPublicModelsProvider(providerId)` to avoid 404s on private providers.
- **Unit test** at `tests/unit/duckduckgo-web-models.test.js` asserts registry integrity, public-provider classification, and context length on the new Haiku entry.

# v0.15.55 (2026-08-28)

## Fix: Kilo Free Models Sync, Catalog Integration & Auto-Combo Info Resolution

- **`kilo-gateway` Provider Registry:** Added `hasFree: true`, `modelsFetcher` (`https://api.kilo.ai/api/gateway/models`, type: `openrouter-free`), `passthroughModels: true`, and all active free models (`stepfun/step-3.7-flash:free`, `tencent/hy3:free`, `meituan/longcat-2.0-free`, `poolside/laguna-s-2.1:free`, etc.) to the provider definition.
- **Kilo Free Models Endpoint:** Anchored free model filtering in `/api/providers/kilo/free-models` to accurately capture `isFree: true`, zero-pricing, and `:free` suffix models while rejecting paid models.
- **Provider Details Page UI:** Updated `/dashboard/providers/[id]` to fetch Kilo free models for both `kilocode` and `kilo-gateway` provider routes.
- **`/v1/models/info` Auto-Combo Support:** Integrated `resolveVirtualAutoCombo` to resolve `auto/*` zero-config combos with non-empty member validation and context metadata.
- **Free Model Catalog Data:** Synced all 20+ active Kilo free models into `open-sse/config/freeModelCatalog.data.js`.

# v0.15.54 (2026-08-28)

## Feat: `auto/best-free-1m` & `auto/free-1m` 1M-Context Auto Combos

- **`auto/best-free-1m` Zero-Config Template:** Added `auto/best-free-1m` to `AUTO_COMBO_TEMPLATES` and `AUTO_TEMPLATE_VARIANTS` with `contextMin: 1000000`.
- **Suffix Parsing:** Added support for `best-free-1m`, `free-1m`, and `free:1m` in `parseAutoSuffix()`.
- **Strict Context Filtering:** Enforced `resolveKnownContextWindow` in `resolveVirtualAutoCombo()` to guarantee all materialized candidates strictly carry >= 1M context window (guaranteeing `context_length: 1000000` in `/v1/models`).
- **Capability Registry Alignment:** Registered `auto/best-free-1m` and `auto/free-1m` in `MODEL_CAPABILITIES` with `contextWindow: 1000000` and `maxOutput: 128000`.

# v0.15.53 (2026-08-28)

## Feat: `9-free` 1M Context Window Support & Capability Registry Alignment

- **`open-sse/providers/capabilities.js`:** Added `9-free` to `MODEL_CAPABILITIES` with `contextWindow: 1000000`, `maxOutput: 128000`, `vision: true`, `reasoning: true`, `search: true`, and `thinkingFormat: "openai"`.
- **Combo Curation:** Curated `9-free` combo member models to ensure all members carry 1,000,000+ context window across active providers (`minimax-m3:free`, `deepseek-v4-pro-0813-free`, `kimi-k3-free`, `qwen3.8-max-free`, `nemotron-3-ultra:free`, `longcat-2.0:free`).
- **Context Limit Resolution:** Verified `/v1/models` and `/v1/models/info` advertise `context_length: 1000000` for `9-free` and all 1M-capable combo routes.

# v0.15.52 (2026-08-28)

## Feat: Add AIHubMix OpenAI-Compatible Provider

- **AIHubMix (`aihubmix`)** — new `apikey`-category provider pointing to `https://aihubmix.com/v1/chat/completions`. Closes #323.
- 7 curated models: 4 `auto` router IDs (`auto`, `auto:balanced`, `auto:quality_first`, `auto:latency_critical`) + 3 free tier (`glm-5.2-free`, `dots-3-note-preview-free`, `gemini-3.7-flash-free`).
- `models` endpoint at `https://aihubmix.com/v1/models` (850+ models available via dynamic sync).
- Inject `import p132 from "./aihubmix.js"` into `open-sse/providers/registry/index.js`.

# v0.15.51 (2026-08-27)

## Fix: Cloudflare Workers AI Model Sync Returns Empty List

- **Root Cause**: Cloudflare `/ai/models/search` API changed response format — `task` field is now an object `{ id, name }` (e.g., "Text Generation") instead of boolean flags, and model slug `@cf/...` moved to `name` field.
- **Fix**: Extract `parseCloudflareModelsResponse()` helper in `src/lib/cloudflareAiModels.js` handling both legacy boolean `task["text-generation"]` and modern `task.name` ("Text Generation", "Text-to-Image") formats. Accepts `@cf/...` slug from `name` or `id` field. Update `cloudflare-ai` provider in `src/app/api/providers/[id]/models/route.js` to use shared parser.
- **Scope**: Text generation (LLM) and Text-to-Image models now sync correctly; ASR/Translation tasks filtered out.

# v0.15.50 (2026-08-27)

## Feat: Expose Zero-Config Auto-Combo Templates in /v1/models

- **`auto/*` virtual combos now visible in OpenAI `/v1/models` response:** `auto/best-coding`, `auto/best-reasoning`, `auto/best-fast`, `auto/best-vision`, `auto/best-free`, `auto/cheap` are injected with `isCombo=true`, `comboCategory/Tier/Strategy`, `comboMembers`, `context_length`/`max_output_tokens` via existing combo field resolvers (closes #317).
- **Injection moved after `if (connections.length===0)` branch** so both static-fallback and dynamic provider paths emit virtual combos (per agy review round 3).

# v0.15.49 (2026-08-26)

## Feat: Zero-Config Auto-Combo Template Gallery & Provider Review Fixes

- **Zero-Config Auto-Combo Template Gallery (`/dashboard/combos`):**
  - Surfaced 6 built-in `auto/*` dynamic combo templates (`auto/best-coding`, `auto/best-reasoning`, `auto/best-fast`, `auto/best-vision`, `auto/best-free`, `auto/cheap`) on `/dashboard/combos`.
  - Added **Snapshot** button to prefill manual combo create modal from template defaults.
  - Added **Copy** button for instant model ID copy (`auto/*`) to use directly in Claude Code, Cursor, or Cline.
  - Reserved `auto/*` prefix in `/api/combos` POST so manual DB combos cannot collide with virtual templates (#315).
- **Provider Review Fixes & Stability:**
  - Fixed `AddApiKeyModal.js` `ReferenceError: defaultRegion is not defined` client-side crash on provider detail pages (#313, closes #312).
  - Restored `apiKey`/`providerSpecificData` destructuring in `validate/route.js` (#314).
  - Removed global in-memory capability registration in `[id]/models/route.js` to prevent cross-provider capability bleed; capability data now persists strictly provider-scoped in DB (#314).
  - Repointed `zenmux-free` transport format to `"claude"` so `openai-to-claude` request translator runs (#314).
  - Repointed `felo-web` transport to `openapi.felo.ai` OpenAI-compatible `/api/v1/chat/completions` LLM API with API key auth (#314).

# v0.15.48 (2026-08-26)

## Feat: 5 Permanent Free Providers, Universal Model Sync Fallback & Free-Tiers 1-Click UI

- **5 Permanent Free Providers:**
  - `duckduckgo-web`: Keyless DuckDuckGo AI gateway (`gpt-5.4-mini`, `gpt-5.4-nano`, `claude-haiku-4-5`, `mistral-small-2603`, `tinfoil/gpt-oss-120b`, `tinfoil/gemma4-31b`).
  - `felo-web`: Keyless Felo AI Search gateway (`felo-chat`, `felo-search`, `felo-scholar`, `felo-social`, `felo-document`).
  - `cheaperinference`: Cost-ranked gateway (`claude-opus-4-8-fast`, `claude-fable-5`, `claude-haiku-4.5`, `gpt-5`, `deepseek-v4-pro`).
  - `freebuff`: Codebuff developer gateway (`deepseek/deepseek-v4-pro`, `openai/gpt-5.6-luna`, `minimax/minimax-m3`, `mimo/mimo-v2.5`, `z-ai/glm-5.2`, `crof/kimi-k3-eco`).
  - `zenmux-free`: Session cookie gateway (`deepseek/deepseek-chat`, `deepseek/deepseek-reasoner`, `deepseek/deepseek-v4-pro`, `z-ai/glm-4.7-flash-free`, `stepfun/step-3.5-flash-free`, `inclusionai/ling-1t`).
- **Universal Dynamic Model Sync & Graceful Static Catalog Fallback:**
  - Upgraded `/api/providers/[id]/models` with universal dynamic endpoint builder from registry `baseUrl`/`validateUrl`.
  - Added seamless static catalog fallback (`PROVIDERS[p].models`) for public/keyless providers and when upstream returns 401/404/network error, resolving sync issues for `agentrouter` and `api-airforce`.
- **Free Tiers & Zero-Cost Models UI Enhancements:**
  - Added 1-Click Connect button and Copy Model Expression action in `/dashboard/free-tiers` table.
  - Added Keyless connection mode in `AddApiKeyModal.js` and `validate/route.js` accepting `authType: "none"`.
- **Combos UI Expansion:**
  - Exposed all 10 routing strategies (`Priority Fallback`, `Round Robin`, `Cache-Optimized`, `P2C`, `Reset-Aware`, `Cost-Optimized`, `Headroom`, `Least-Used`, `Random`, `Fusion`) in Combo Strategy selector.

# v0.15.47 (2026-08-26)

## Feat: ChatGPT Web Cookie Provider (`chatgpt-web`)

- **New Provider:** Added `chatgpt-web` provider in registry (`open-sse/providers/registry/chatgpt-web.js`) under `category: "webCookie"`.
- **Supported Models:** Supports `gpt-5.6-luna-free`, `gpt-5.6-luna-free-thinking`, `gpt-5.6-sol-pro`, `gpt-5.6-sol-high`, `gpt-5.6-sol-instant`, `gpt-5.5-pro`, `gpt-5.5-high`, `gpt-5.5-instant`, `gpt-4o`, `gpt-4o-mini`.
- **Auth & Session Validation:** Supports `__Secure-next-auth.session-token` cookie or raw session tokens from `chatgpt.com` with pre-flight session check.

# v0.15.46 (2026-08-26)

## Fix: AgentRouter Model Sync 401 Graceful Fallback & Dual Auth

- **Dual Auth & Wire Headers:** Upgraded AgentRouter `/v1/models` discovery request to send dual auth (`Authorization: Bearer <key>` + `x-api-key: <key>`) alongside Claude Code wire headers (`anthropic-version`, `anthropic-beta`, `x-app`).
- **Graceful Built-in Catalog Fallback:** When upstream `https://agentrouter.org/v1/models` returns 401/404 or fails, the sync endpoint now returns gracefully so UI falls back seamlessly to the built-in static model list (`claude-opus-4-8`, `claude-opus-5`, `claude-sonnet-4-6`, `claude-3-7-sonnet`, `gpt-5.6-sol`, `gpt-4o`, `deepseek-v3`, `deepseek-r1`, `gemini-2.5-flash`) instead of throwing an unhandled 401 error modal.
- **Tests:** Added `tests/unit/agentrouter-sync.test.js`.

# v0.15.45 (2026-08-26)

## Feat: OmniRoute 5-Pillar Full Parity Release

- **Free-Tiers Catalog & Dashboard (`/dashboard/free-tiers`):** Full dataset of 42+ providers (495+ models) with pool-deduplicated monthly quota calculation (~1.51B tokens/mo), uncapped provider tracking, TOS privacy indicators, and countdowns.
- **Auto-Combo 2.0 & Suffix Composition:** Zero-configuration dynamic virtual combos (`auto/best-free`, `auto/coding:fast`, `auto/cheap`, `auto/best-coding`, `auto/best-reasoning`, `auto/best-vision`) without requiring static DB rows.
- **Advanced Routing Strategies:** Added `p2c` (Power-of-Two-Choices latency minimization), `reset-aware` (expiring quota priority), and `cache-optimized` (prefix prompt cache pinning).
- **Modality Bridge & Auto-Reroute:** Added sibling vision model detection (`findFamilyVisionModel`) and automated image-to-text fallback with SHA-256 caching.
- **AgentRouter Integration & Fixes:** Added official AgentRouter logo (`agentrouter.png`), dynamic model sync endpoint (`/v1/models` with Claude Code wire image), and connection validation.
- **Embedded MCP Server (`/api/mcp`):** Standards-compliant JSON-RPC 2.0 & SSE MCP Server exposing tools `list_models`, `check_free_quotas`, `get_auto_combos`.
- **Tests:** Added `tests/unit/free-model-catalog.test.js`, `tests/unit/auto-combo-parity.test.js`, `tests/unit/mcp-server-protocol.test.js`.

# v0.15.44 (2026-08-26)

## Feat: OmniRoute Parity Port (Codex completed tools, Cache-optimized combos, Modality Bridge, AgentRouter)

- **Codex CLI Tool Retention (#8990 parity):** In OpenAI Responses API streaming, `response.created` and `response.in_progress` have `instructions` and `tools` stripped, while `response.completed` preserves `tools` so Codex CLI retains full tool registry.
- **Smart Routing & Telemetry:** Added `cache-optimized` combo strategy using 32-bit FNV-1a prompt prefix hashing (first 2,048 chars) and `X-Router-Decision` telemetry headers.
- **Modality Bridge:** Added automatic vision-to-text image description layer with SHA-256 caching (30m TTL) when multimodal requests hit text-only models.
- **AgentRouter Provider & Error Rules:** Added `agentrouter` provider preset ($200 free credits, Claude/OpenAI/Responses formats) and Chinese/English quota error classification (`额度不足`, `insufficient_quota`).
- **Tests:** Added `tests/unit/responses-completed-tools.test.js`, `tests/unit/combo-cache-optimized.test.js`, `tests/unit/modality-bridge.test.js`, `tests/unit/agentrouter-provider.test.js`.

# v0.15.43 (2026-08-25)

## Feat: GMI Cloud provider (`gmi`) with Kimi K3 seed

- **New provider:** GMI Cloud serverless inference (`api.gmi-serving.com/v1`) as an OpenAI-compatible API-key card. Aliases: `gmi`, `gmi-cloud`, `gmicloud`.
- **Kimi K3:** Seed id `moonshotai/kimi-k3` from [GMI's Kimi K3 post](https://www.gmicloud.ai/en/blog/kimi-k3-open-weights-are-here-the-benchmark-phase-starts-now). Also seeds `deepseek-ai/DeepSeek-V4-Pro` from the [developers curl](https://www.gmicloud.ai/en/developers). Other catalogue ids via Sync/`passthroughModels` after a key — do not invent OpenClaw-only ids.
- **Sync:** `modelsFetcher` + `passthroughModels` plus `PROVIDER_MODELS_CONFIG` (`gmi` / `gmi-cloud` / `gmicloud` → `https://api.gmi-serving.com/v1/models`). `GET /v1/models` requires a Bearer key (observed 401 without Authorization) — connect a key in the dashboard, then Sync.
- **Not a $0 SKU:** GMI bills per token in Model Hub. This is not a documented free-tier model; add it to a combo only after a live key works.
- **Tests:** `tests/unit/gmi-provider.test.js`. Logo: `public/providers/gmi.png`.

# v0.15.42 (2026-08-25)

## Feat: B.AI (`bai`) OpenAI-compatible API-key provider

- **Gateway:** [B.AI LLM Service API](https://docs.b.ai/llmservice/api/) at `https://api.b.ai` (OpenAI-compatible `POST /v1/chat/completions` + `GET /v1/models`; Bearer or `x-api-key`). OpenClaw namespace is `"b.ai"` ([integration guide](https://docs.b.ai/llmservice/openclaw/integration-guide/)); Claude Code uses hyphenated ids such as `claude-sonnet-4-6`.
- **Auth:** GET `/v1/models` without a key returns 401 `Invalid token` (header `x-oneapi-request-id`) — not a public models provider. Dashboard Sync uses `PROVIDER_MODELS_CONFIG` (`bai` / `b-ai` → `https://api.b.ai/v1/models`) with a stored key.
- **Seed (documented ids only):** `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `hy3` (256K), `gpt-5.2`, `claude-sonnet-4-6`, `glm-5.2`. Live catalogue via `modelsFetcher` + `passthroughModels` after a key. Do not invent `mimo-v2.5`.
- **Pricing:** Limited-time 0-credit API promos (DeepSeek V4 Flash, Hy3, MiMo) per [promotions](https://docs.b.ai/llmservice/promotions-and-pricing-notices/) are **not** a documented permanent $0 SKU — they return to standard pricing after the offer. GLM-5.2 is 60% of standard, not free. Not added to live combos / 9-free.
- **Caps:** `*deepseek-v4-flash-vision*` (vision) before text-only `*deepseek-v4*` (`vision: false`). Hy3 stays 262144 via existing `hy3*` glob.
- **Dashboard:** `public/providers/bai.png` (official `https://b.ai/favicon.ico`). Aliases: `bai`, `b-ai`, `b.ai`.

# v0.15.41 (2026-08-24)


## Fix: Allow public model sync for OpenCode Go (`opencode-go`, `ocg`) & OpenRouter

- **Public Model Listing**: Added `opencode-go`, `ocg`, and `openrouter` to `isPublicModelsProvider` in `src/shared/constants/providers.js` so clicking Sync Models fetches the live catalog without requiring a pre-saved API key in DB.
- **Tests**: `tests/unit/group-a-models-config.test.js`.

# v0.15.40 (2026-08-24)

## Fix: Ox Alpha context length resolution & sync modal context_length parsing

- **OpenRouter & Nous Ox Alpha Caps**: Wired `stealth/ox-alpha` and `ox-alpha` in `PROVIDER_CAPABILITIES` for `openrouter`, `nousresearch`, and `nous` with 1M context (`contextWindow: 1000000`) and 131k output (`maxOutput: 131072`), preventing fallback to 200k default.
- **Sync Modal Context Parsing**: Added `item.context_length` and `item.top_provider?.context_length` support to `normalizeModel` in `SyncProviderModelsModal.js` so OpenRouter models display their full 1M context badge.
- **Tests**: `tests/unit/ox-alpha-capabilities.test.js`.

# v0.15.39 (2026-08-24)

## Fix: Wire Nous Research in models listing endpoint (`/api/providers/[id]/models`)

- **Root Cause**: `PROVIDER_MODELS_CONFIG` was missing `nousresearch` endpoint, causing `/api/providers/[id]/models` to reject model sync requests with `"Provider nousresearch does not support models listing"`.
- **Public Sync Support**: Allowed unauthenticated model sync when `isPublicModelsProvider` is true so models can be fetched without an active API key in DB.
- **Tests**: `tests/unit/group-a-models-config.test.js`.

# v0.15.38 (2026-08-24)

## Feat: Native Nous Research Portal provider (complete flow)

- **Was a stub:** `nousresearch` previously proxied OpenRouter (`openrouter.ai`) with stale Hermes 3 IDs and no dashboard logo, so the card looked broken / unusable.
- **Native gateway:** `https://inference-api.nousresearch.com/v1/chat/completions` (+ `/v1/models`, `/v1/embeddings`) per [Nous Portal docs](https://hermes-agent.nousresearch.com/docs/integrations/nous-portal) (`base_url: https://inference-api.nousresearch.com/v1`). Live catalog 2026-08-23: 373 models.
- **Dashboard flow:** API-key card + `public/providers/nousresearch.png`, `modelsFetcher` + `passthroughModels`, public model sync (`GET /v1/models` is unauthenticated), featured seed includes Hermes 4 70B/405B.
- **Caps:** `*hermes-4*` → reasoning, text-only, 131k context (Portal live architecture).
- **Tests:** `tests/unit/nousresearch-provider.test.js`.

# v0.15.37 (2026-08-23)

## Feat: OpenCode Ox Alpha Free (`oc/x-preview-f-free`, `ocg/ox-alpha-free`)

- **OpenCode Zen**: rename static model `x-preview-f-free` to **Ox Alpha Free** (Chat Completions, `@ai-sdk/openai-compatible` per [Zen docs](https://opencode.ai/docs/zen/)).
- **OpenCode Go**: add `ox-alpha-free` as Chat Completions-only (`supportedFormats: ["openai"]`).
- **Capabilities** (models.dev, 2026-08-23): provider-scoped 1M context / 131k max output, image input, mandatory reasoning `low|high|max` (`thinkingCanDisable: false`). Video input stays off until the common video transport is verified.
- **Thinking wire**: new `openai-low-high-max` format so `none/minimal` clamp to `low` and `xhigh/max/ultra` map to `max` (OpenAI `gpt-5` still uses `xhigh`).
- **Tests**: `tests/unit/ox-alpha-capabilities.test.js`, `tests/unit/opencode-ox-alpha-free.test.js`.

# v0.15.36 (2026-08-21)

## Fix: Security hardening for Devin CLI host bridge & Trae error redaction (#303)

- **Devin CLI Security Gate (`open-sse/executors/devin-cli.js`)**:
  - Gated execution behind `DEVIN_CLI_ENABLE=1` (disabled by default) to prevent unauthorized host agent execution via remote chat requests.
  - Removed prompt text scanning for `<cwd>...</cwd>` tags; only structured, validated absolute directories in request fields (`body.cwd`, `body.working_directory`, etc.) are allowed.
  - Isolated subprocess environment to an allowlist of safe keys (`PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, `XDG_*`, `DEVIN_*`) rather than leaking server secrets (`JWT_SECRET`, database keys, auth tokens).
  - Replaced static temp MCP script path with a randomized, dedicated directory (`fs.mkdtempSync`) with `0o700` directory mode and `0o600` file mode.
  - Enforced `shell: false` for all child process spawns.
- **Trae Error Redaction (`open-sse/executors/trae.js`)**:
  - Truncated and redacted upstream error responses to prevent leaking tokens or internal session IDs in error stack traces.
- **Tests**:
  - `tests/unit/devin-cli-executor.test.js`: Added assertions for security gate, explicit cwd enforcement, and prompt cwd injection prevention.

# v0.15.35 (2026-08-21)

## Feat: Port upstream v0.5.55 features (Items 1-4) & add Grok 4.6 default model to xAI (#302)

- **IDE & Agent CLI Bridges (Item 1)**:
  - Added dedicated bridge executors and OAuth configs for `grok-cli` (`cli-chat-proxy.grok.com`), `devin-cli` (stdio ACP bridge), `trae` (`core-normal.trae.ai`), `windsurf` (Codeium gRPC-web protocol), and `zed` (`cloud.zed.dev`).
  - Added `BUILTIN_MODEL_ALIASES` mapping `grok-build` to `gcli/grok-build`.
- **Video Generation Endpoint (Item 2)**:
  - Added `/v1/videos/generations`, `/v1/videos/edits`, `/v1/videos/extensions`, and `/v1/videos/[id]` REST routes.
  - Implemented `open-sse/handlers/videoCore.js` and `src/sse/handlers/videoGeneration.js` supporting async job polling and multipart form video generation with xAI (`grok-imagine-video`).
- **Usage Trackers & Quota Bars (Item 3)**:
  - Added quota parsers and fetchers for `deepseek` (`/user/balance`), `kimi` (`/v1/usages`), and `grok-cli` (billing credits & quota frames).
  - Integrated `remainingPercentage` for balance rows in dashboard `ProviderLimits`.
- **Fast Inference & Specialized Providers (Item 4)**:
  - Ported 20+ specialized provider registries: `sambanova`, `perplexity-agent`, `poolside`, `featherless`, `kilo-gateway`, `morph`, `bluesminds`, `api-airforce`, `llm7`, `bazaarlink`, `baidu`, `tencent`, `codebuddy-intl`, `selfhosted-tts`, `selfhosted-stt`, `selfhosted-embedding`.
  - Added TTS adapters for `xiaomi-mimo` and `selfhosted-tts`.
  - Added embedding adapter for `selfhosted-embedding`.
- **Grok 4.6 Model Support**:
  - Added `grok-4.6` to default models list in `open-sse/providers/registry/xai.js`.
  - Confirmed 500k context window and reasoning translation across OpenAI and Claude SSE formats.
- **Tests**: All 218 test files (2,219 unit tests) passed 100%. Refreshed golden URL baseline snapshots.

# v0.15.34 (2026-08-21)

## Fix: OpenCode muse-spark HTTP 400 from empty content arrays and advertised vision (#300)

- **`open-sse/executors/opencode.js`**:
  - Extended `transformRequest` sanitization beyond `content: null`/`undefined`. Empty `content: []` collapses to `""`. Text-only part arrays with `text: null`, missing `text`, `[null]`, or bare strings collapse to a joined string (empty segments dropped so all-null does not become a newline). Valid text-part arrays and mixed/image arrays are left untouched. Assistant turns with non-empty `tool_calls` still omit `content`.
  - Evidence: live OpenCode Zen returned HTTP 400 with an empty `chat.completion` body for `content: []`, `[{type:"text", text:null}]`, and `[{type:"text"}]` on `muse-spark-1.2-contributor-free`.
- **`open-sse/providers/capabilities.js`**:
  - `PROVIDER_CAPABILITIES` OpenCode SKU override for `muse-spark-1.2-contributor-free` on `opencode` / `opencode-go` / `opencode-zen`: `vision: false, pdf: false, audioInput: false, videoInput: false`. Family pattern `*muse-spark*` stays multimodal for other providers. Context window 1M / max output 131k unchanged.
  - Evidence: live Zen HTTP 400 on a 1×1 PNG `image_url`. Same defect class as #198 (wrong vision flag skips modality strip).
- **Tests**:
  - `tests/unit/opencode-executor.test.js`: empty arrays, nested null/missing text, `[null]`, bare strings, all-null join, `input_text`, valid text parts, mixed image arrays, tool_calls content left undefined.
  - `tests/unit/opencode-models-sync.test.js`: OpenCode SKU modalities false; family pattern still true.

# v0.15.33 (2026-08-21)

## Fix: OpenCode HTTP 400 null message content sanitization & 1M context + multimodal capabilities (#301)

- **`open-sse/executors/opencode.js`**:
  - In `OpenCodeExecutor.transformRequest`, sanitized messages with `content: null` or `content: undefined` to `content: ""` (for user, assistant turns without `tool_calls`, and tool response turns). Upstream OpenCode Zen API rejects null content with HTTP 400 (`{"choices":[{"index":0,"message":{"role":"assistant"},"finish_reason":null}]}`), which previously caused requests to fail.
- **`open-sse/providers/capabilities.js`**:
  - `*muse-spark*`: Set context window to 1,048,576 (1M tokens), max output to 131,072, and enabled full multimodal flags (`vision: true, pdf: true, audioInput: true, videoInput: true, reasoning: true`).
  - `*nemotron-3-ultra*`: Set context window to 1,000,000 (1M tokens), max output to 128,000, and explicit `vision: false, reasoning: true`.
  - `*laguna-s*`: Set family pattern to native 1,048,576 tokens / 32,768 max output, and added `PROVIDER_CAPABILITIES` provider overrides for `opencode`, `opencode-go`, `opencode-zen` mapping `laguna-s-2.1-free` to the OpenCode Zen SKU limit of 256,000 context / 32,000 max output.
- **Tests**:
  - `tests/unit/opencode-models-sync.test.js`: Verified 1M context, max output, and multimodal capability resolution for Muse Spark 1.2, Nemotron 3 Ultra, Laguna S 2.1 family, and OpenCode SKU overrides.
  - `tests/unit/opencode-executor.test.js`: Verified null and undefined message content sanitization across user, assistant (with empty / non-empty `tool_calls`), and tool message roles.

# v0.15.32 (2026-08-21)

## Fix: OpenCode ModelError treated as model-level error & Combo stream guard Anthropic max_tokens reasoning retry (#300)

- **`open-sse/config/errorConfig.js`**: Added `{ text: "\"type\":\"modelerror\"", modelError: true }` and `{ text: "promotion has ended", modelError: true }` rules so when upstream OpenCode returns a model-level error (e.g. decommissioned free model promotion ending), 888router treats it as a model error rather than an account-level 401 auth failure. This prevents false provider-level account / proxy pool quarantines that previously blocked all subsequent free model requests with cached 401s.
- **`open-sse/services/combo.js`**:
  - `isReasoningEmptyContent`: Extended `finishReason` check to include Anthropic format `"max_tokens"` alongside OpenAI format `"length"`.
  - `handleComboChat`: Stream guard reasoning budget exhaustion retry now triggers on both `length` and `max_tokens` (`guard.finishReason() === "length" || guard.finishReason() === "max_tokens"`), allowing Claude Code and other Anthropic-format clients to automatically retry reasoning models that burned their token budget during thinking.
  - `withRaisedMaxTokens`: Added a minimum token floor of 2048 (`Math.min(Math.max(original * 3, original + 512, 2048), 65536)`), ensuring reasoning models have sufficient budget to output both reasoning deltas and final text content.
- **Tests**:
  - `tests/unit/combo-routing.test.js`: Added test cases for OpenCode `ModelError` and `promotion has ended` error classifications.
  - `tests/unit/combo-stream-fallback.test.js`: Added tests for Anthropic SSE format thinking stream retry on `stop_reason: "max_tokens"`, and `isReasoningEmptyContent` unit test.

# v0.15.31 (2026-08-21)

## Fix: OpenCode Zen Free can now sync models without an existing DB connection and added latest free models (#299)

- **`src/app/api/providers/[id]/models/route.js` & `src/shared/constants/providers.js`**: `isPublicModelsProvider` allows fetching upstream models for public/no-auth providers (e.g. `opencode`, `opencode-zen`) by fallback when no database connection record exists, instead of returning 404.
- **`src/app/(dashboard)/dashboard/providers/[id]/page.js` & `SyncProviderModelsModal.js`**: Enabled "Sync Models" button and automated fallback to `providerId` when `activeConnections` is empty, allowing seamless model discovery and syncing for public providers without manual connection setup.
- **`open-sse/providers/registry/opencode.js` & `open-sse/providers/capabilities.js`**: Added active upstream free models (`mimo-v2.5-free`, `hy3-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `x-preview-f-free`, `laguna-s-2.1-free`, `muse-spark-1.2-contributor-free`, `big-pickle`) and resolved their reasoning/modality/context window capabilities.
- **Tests**: `tests/unit/opencode-models-sync.test.js` covers static registry presence, `isPublicModelsProvider` helper validation, capability resolution, and suggested-models filtering.

# v0.15.30 (2026-08-18)

## Fix: `reasoning_effort="ultra"` no longer 400s or silently drops thinking per provider

- **`open-sse/translator/concerns/thinking.js`:** added `ultra` to `EFFORT_LEVELS` and `LEVEL_TO_BUDGET` (160000) so the level is recognized as a "max+" request.
- **`open-sse/translator/concerns/thinkingUnified.js`:** `toLevel()` clamps `ultra → xhigh` (highest enum OpenAI/Codex accept — `max` would still 400 there; kimi/deepseek map `xhigh→max` downstream so they lose nothing) so no wire format ever sees the invalid string. Claude-adaptive `output_config.effort` now maps every level onto the native enum (low/medium/high only, `minimal→low`, beyond-`high`→`high`, `auto` omits `output_config`). Budget formats (`claude-budget`, `gemini-budget`, `qwen`) now clamp the budget to `caps.maxOutput` (strict `<`, so `budget_tokens` never equals `max_tokens` — Anthropic rejects that); `hunyuan` (maxOutput 262144) passes 160000 through untouched. Result per provider: OpenAI/Codex `reasoning_effort=xhigh`, Claude adaptive `effort=high`, Kimi/DeepSeek `max`, Step/Gemini `high`, Claude/gemini/qwen budgets clamp to the model's output cap — instead of upstream 400s (openai/codex/gemini/claude/step) or silent collapse (kimi).
- **Test:** `tests/translator/thinking-unified.test.js` covers ultra across openai, claude-adaptive, claude-budget, gemini-3, kimi, deepseek, step, qwen, hunyuan, plus claude-adaptive `minimal`/`auto` regressions.

# v0.15.29 (2026-08-18)

## Fix: `/v1/models` combo entries now advertise capabilities — clients see tool support

- **`src/app/api/v1/models/route.js`:** LLM combo entries (e.g. `9-deepseek-v4-flash`, `9-sonnet`) built via `applyComboContextFields` previously had **no `capabilities` field** at all, so Claude Code treated them as not supporting tool calling and used MCP tools poorly. Combo entries now emit `DEFAULT_CAPABILITIES` — `tools:true` for LLM combos, `tools:false` for non-LLM kinds — while preserving any pre-existing capabilities and ignoring non-object values.
- **Test:** `tests/unit/combo-models-context.test.js` covers tools advertisement, non-LLM shape, and pre-existing-capabilities preservation.

# v0.15.28 (2026-08-18)

## Fix: `/v1/models` now reads synced dynamic capabilities from the DB, so a synced model reports its real context window without a per-model pattern edit

- **`open-sse/providers/capabilities.js`:** added `*grok-4.6*` / `*grok-4-6*` pattern entries (500k, matching `grok-4.5`, per `models.dev`) above the catch-all `*grok-4*`. Without them, `xai/grok-4.6` fell to that generic 256k.
- **The systemic fix:** the provider-model sync endpoint (`src/app/api/providers/[id]/models/route.js`) already persisted per-model dynamic capabilities (`contextWindow`/`vision`/`reasoning`) to the DB — but `/v1/models` resolved capabilities purely from the static `PATTERN_CAPABILITIES` table and never read them back, which is why context went stale for every model the static table predates. Every new model previously needed a pattern edit.
- **`src/lib/db/repos/syncedModelsRepo.js`:** added `getAllModelDynamicCapabilities()` — bulk `SELECT` of the `modelCapabilities` scope, now keyed `providerId:modelId` so one provider's sync cannot bleed into the same model id on another connection. Reader rejects a non-positive-finite `contextWindow` and strips the `updatedAt` persistence stamp so it never leaks into the model payload. Legacy bare-key rows (pre-scoped builds) still resolve via fallback.
- **`src/app/api/v1/models/route.js`:** `buildModelsList` now bulk-loads the synced caps once per request (hoisted above the per-provider loop, fail-open) and overlays them in the resolution chain with precedence **live upstream > synced (scoped `providerId:modelId`, then legacy bare) > static pattern**. Live tells win over a stale sync; a fresh sync wins over the static table. Provider-model sync is now the source of truth for a model's context window.
- **Tests:** `tests/unit/synced-dynamic-caps.test.js` (bulk loader: scoped keys, `updatedAt` stripped, malformed-context rejection, provider isolation, empty on no sync), a `v1-models-claude-dash-ids` case proving a synced 300k overlay beats the static `*grok-4*` 256k end-to-end through `GET /v1/models`, plus a legacy bare-key fallback case and `grok-4.6` → 500k static safety net.

# v0.15.27 (2026-08-16)

## Fix: synced models lost every capability the sync did not carry (#283)

- **`open-sse/providers/capabilities.js`:** dynamic capabilities (from the provider sync / DB) now **layer over** the resolved static entry instead of replacing it. They were merged over `DEFAULT_CAPABILITIES` alone, skipping `PROVIDER_CAPABILITIES` / `MODEL_CAPABILITIES` / `PATTERN_CAPABILITIES` entirely, so any field the sync did not record silently fell back to the floor.
- **Observed symptom:** `kr/claude-opus-5` advertised `max_tokens: 64000` while its own `MODEL_CAPABILITIES` entry says `128000` — and its `-thinking` / `-agentic` variants, which are never synced and so were never overwritten, correctly reported `128000`. A base model disagreeing with its own variants about a value that comes from the same table was the tell.
- **Why it was systemic, not one bad entry:** the sync records only `{ contextWindow, vision, reasoning }` (`src/app/api/providers/[id]/models/route.js`), so **every** synced model also lost `thinkingFormat`, `search`, `pdf`, `thinkingRange`, and the rest. `contextWindow` looked fine purely because it happens to be one of the three fields the sync carries.
- **Why the existing safety net missed it:** `/v1/models` fills gaps only when a value is not `Number.isFinite`, and `64000` is a perfectly finite number — just the wrong one. Nothing downstream could tell a floor value from a real one.
- **Provider-specific overrides are applied LAST — above dynamic, not below.** An override is a hand-written statement about one provider's upstream ("this provider's deepseek-v4-pro is text-only"), so a live sync must not contradict it. An earlier revision of this change layered them under dynamic, which let a synced `vision: true` overturn `codebuddy-cn`'s deliberate `vision: false` — the defect class of #198, where the wrong flag stops the translator stripping `image_url` and the upstream 400s. Caught in review and pinned by four tests, including that a *different* provider of the same model still sees the synced value.
- **Dynamic caps still win where they have a value** — that is the point of the layer, e.g. a live catalog reporting a context window the static table does not know yet. Verified an explicit `false` also still overrides, rather than being treated as absent.
- **`resolveKnownContextWindow()` was already correct** and is unchanged: it reads a single field (`dyn.contextWindow != null`) instead of spreading the object, so it never had this bug. Pinned by a test so the refactor cannot change it.
- **Tests (`tests/unit/dynamic-caps-merge-order.test.js`, 14 new):** the synced-base case, base-agrees-with-its-variants, the fields the sync never carries, dynamic-still-wins, explicit-`false`, a dynamic-only model unknown to the static table, the genuinely-unknown floor, provider-override precedence, and `resolveKnownContextWindow` non-regression. Full suite: 1828 pass / 16 fail, all 16 pre-existing on a clean checkout (13 `AUDIT-*`, 3 `GOLDEN buildHeaders`).

## Fix: docker arm64 build flaked under QEMU — build natively per arch (#281)

- **`.github/workflows/docker-publish.yml`:** split the single emulated multi-arch build into two **native** per-arch jobs — `linux/amd64` on `ubuntu-latest`, `linux/arm64` on `ubuntu-24.04-arm` (a GitHub-hosted native arm64 runner, free for public repos) — each pushing by digest, then a `merge` job that combines the digests into one manifest list and applies the tags. `setup-qemu-action` is gone.
- **Why:** two docker builds failed on healthy commits with unrelated-looking errors, both under `/dev/.buildkit_qemu_emulator` — a stalled `npm ci` (`ETIMEDOUT`), and `Cannot find module '../lightningcss.linux-arm64-musl.node'` during `next build`. Neither reproduced natively: running the same committed lockfile under `--platform linux/arm64` installed `lightningcss-linux-arm64-musl@1.32.0`, produced the `.node` binary, and required it successfully — including when the npm cache had been populated by an amd64 pass first, which ruled out cross-platform cache contamination. The lockfile declares the arm64-musl optional dep correctly (`os: linux, cpu: arm64, libc: musl`). The emulator was the variable, so it is removed rather than worked around.
- **Tags are applied once, by the merge job.** The per-arch jobs push untagged digests, so a single-arch image can never occupy `:latest` even momentarily — a single-arch image pulls fine but fails to run on the other architecture (`exec format error`), the exact #196 regression.
- **Two guards against publishing a partial manifest:** the merge job asserts both digest artifacts are present and non-empty before creating anything, and after publishing it re-inspects the pushed manifest and fails unless it carries both `amd64` and `arm64`.
- **Retry as a safety net, not the fix:** each arch build gets one automatic retry (`continue-on-error` + a second attempt). Native runners remove the known flake source, but a registry 5xx can still lose a build, and a lost build means `:latest` silently lags master. If both attempts produce no digest the job fails loudly instead of letting the merge proceed.
- **Per-arch GHA cache scopes** (`scope=amd64` / `scope=arm64`): one shared scope would have the two jobs overwrite each other's cache manifest on every run. `fail-fast: false` keeps one arch's failure from cancelling the sibling mid-push.

## Fix: `npm ci` for `tests/` broke CI — its lockfile is gitignored (#284)

- **`.github/workflows/docker-publish.yml`:** reverted the `tests/` dependency step to `npm install`. The multi-arch rework (#281) had switched it to `npm ci`, which fails with `EUSAGE` on a fresh runner because `tests/package-lock.json` is deliberately gitignored (`tests/.gitignore`) and therefore never reaches CI. Root deps stay on `npm ci` — that lockfile *is* tracked — matching `.github/workflows/ci.yml`, which uses `npm install` for `tests/` for this same reason.
- **The verification was the actual mistake, not just the change:** "lockfile is in sync" had been checked by running `npm ci` against a copy of the *local* file, a test that could never fail because it exercised a file the runner never sees. The check that mattered was `git ls-files tests/package-lock.json`, which is empty.
- **`tests/.gitignore` now records why the file stays untracked**, so the same "improvement" is not reapplied.

## Fix: model-sync surfaced a bare status, hiding why the call failed (#279)

- **`src/lib/upstreamErrorDetail.js` (new):** classifies an upstream failure into one of a **fixed table of explanations written by us**, so `Failed to fetch models: 403` becomes `Failed to fetch models: 403 — out of credits or subscription required (billing, not auth — refreshing the token will not help)`. Thirteen reason classes (billing, quota, auth invalid/expired/missing, permission, not-found, unsupported, server, unavailable, timeout, network, blocked) are matched from keyword signals in the body, with the HTTP status as fallback. Billing is matched ahead of auth deliberately — a billing failure is usually worded like an auth failure, which is exactly the #272 misdiagnosis.
- **Why it mattered:** the distinguishing text was already read into `errorText` and logged server-side, then dropped before the response. From the dashboard a billing 403 and an auth 403 were the same string, so "retry still hits 403" looked like a refresh bug when no refresh could ever have helped.
- **No byte of the upstream body is emitted — the body is only ever matched against.** This is a deliberate reversal of the first design, which passed the upstream's own message through a redaction pass. Three review rounds each defeated that approach with a new evasion: a bare top-level JSON string bypassed the field allowlist; slicing the input before parsing turned valid oversized JSON into raw text that leaked the guarded fields; a leading NUL flipped JSON detection to plain-text; a control character inside `Bear<ESC>er` defeated the pattern and was then stripped back into a working credential; `password: "correct horse battery staple"` left three words behind; `cookie: a=1; b=secret` left the second pair. The over-broad direction failed symmetrically — the redactor ate `skyscraper`, `ghostwriter`, and `invalid bearer credentials`, and turned `access token could not be validated` into `access token [redacted] not be validated`, destroying the very diagnostic the feature exists to deliver. A denylist over adversarial text was the wrong shape for the problem.
- **Fail-safe by construction:** an unrecognised body yields no reason and the caller falls back to the bare status — the exact pre-#279 message. Evasion costs an attacker a *less* informative error, never a disclosure. Invisible characters (C0, C1, bidi marks, zero-width, BOM) are deleted before matching so a keyword split by one is still recognised, and the folded text never needs to be safe to print because it is never printed.
- **`src/app/api/providers/[id]/models/route.js`:** all four upstream-failure paths (OpenAI-compatible, Anthropic-compatible, `ollama-local`, generic OAuth refresh-retry) now return the classified explanation. Each already had `errorText` in scope — verified per call site, not assumed from a successful find-replace.
- **Server logs no longer receive the raw body either.** All five log sites pass through `safeLogDetail(status, body)`, which emits `status=401 reason=auth_invalid body=61B (not logged)`. Logging the body verbatim persisted any echoed credential to disk — inconsistent with the module's own premise.
- **Also fixed a direct leak found while wiring this up:** the Gemini CLI fallback path interpolated the raw upstream body straight into a `warning` field returned **to the client**. It now carries the same classified explanation.
- **Tests:** `tests/unit/upstream-error-detail.test.js` (24) covers each reason class, the billing-over-auth ordering, status fallback, the never-regress case, and — as the core invariant — a table of twelve bodies replaying **every secret that leaked in any earlier revision**, asserting none appears in the output and that the output is always one of our own strings. A 400-case fuzz pass asserts the same. Three assertions in `tests/unit/models-route-oauth-refresh.test.js` were updated for the intentionally changed strings. Full suite: 1795 pass / 16 fail, all 16 pre-existing on a clean checkout (13 `AUDIT-*`, 3 `GOLDEN buildHeaders` — verified by stash-and-rerun).
- **Tradeoff, stated plainly:** the upstream's exact wording is no longer shown. In exchange the message is actionable (it says whether to re-authenticate, top up, or retry) and cannot leak a credential. The raw body remains available to whoever runs the upstream; it was never a reliable diagnostic for our users anyway.

## Fix: `docker-publish` build job had no timeout, letting stalled runs block the queue for hours (#277)

- **`.github/workflows/docker-publish.yml`:** Added `timeout-minutes: 45` to the `build-and-push` job. It previously inherited the 360-minute default (the `test` job already had 20), so a stalled multi-arch build (QEMU arm64 emulation plus a hung `npm ci`) sat `in_progress` and, combined with `cancel-in-progress: false`, blocked the concurrency group behind it. Three such zombie runs were found and cancelled by hand — two of them from the v0.15.25 release, stuck for ~2 hours. The last 8 successful builds measured 12-18 minutes, so 45 leaves ~2.5x headroom.
- **`concurrency.group` deliberately left on `github.ref`.** A release does fire two runs on one commit (the master push, then the `v*` tag push), which looks like a duplicate-build race. It is not: the two runs publish **disjoint** tag sets — `:latest` and `:sha-xxx` are gated on `{{is_default_branch}}`, and `type=semver` only resolves on the tag event. Verified against the v0.15.24 release logs, where the tag run pushed `:0.15.24` and nothing else. Re-keying the group on `github.sha` would have merged those two harmless runs into one group while **splitting consecutive master pushes apart**, letting commit A and commit B publish `:latest` concurrently — an older build finishing last would clobber the newer `:latest`. A comment now records this so the same "fix" is not attempted again.
- **Corrected a stale comment on the cleanup step:** it claimed to prune "after every build" but has no `if: always()`, so it only runs on success. Left as-is behaviourally — the runner is ephemeral and discarded either way, so pruning after a failure buys nothing — and the comment now says so.
- **Not the same defect as the failed v0.15.26 build**, which died on `npm error code ETIMEDOUT` — a transient runner network failure, cleared by a re-run. The timeout added here is what bounds that class of hang instead of letting it idle for 6 hours.

# v0.15.26 (2026-08-15)

## Fix: `9-opus` / `9-sonnet` / `9-haiku` context limits missing from `/v1/models` (#275)

- **`open-sse/providers/capabilities.js`:** Added exact `MODEL_CAPABILITIES` entries for the 9router aliases — `9-opus` and `9-sonnet` at `contextWindow: 1000000` / `maxOutput: 128000` / `claude-adaptive`, `9-haiku` at `200000` / `claude-budget`, all three with `vision`, `reasoning`, and `search`. These ids carry no `claude` substring, so every `PATTERN_CAPABILITIES` entry missed them and `resolveKnownContextWindow()` returned `undefined`, leaving `/v1/models` and `/v1/models/info` with no limits to advertise. Downstream clients then fell through to their own fallback default — Hermes showed `9-opus │ 170K/256K` instead of 1M.
- **Why exact ids, not a broad pattern:** the obvious-looking fix (a generic `*-opus*` / `*-sonnet*` pattern) was measured and rejected. Because `PATTERN_CAPABILITIES` is first-match-wins and the new entries would sort ahead of the specific ones, it silently promoted `claude-3-opus-20240229` and `claude-opus-4.1` from 200k/budget to 1M/adaptive. An exact-id entry has no blast radius beyond the three aliases.
- **Regression guard (`tests/unit/capabilities-9router-alias-context.test.js`):** 6 new tests pin the resolved capabilities for all three aliases, assert `resolveKnownContextWindow()` now reports 1M for the two large ones, and add an explicit guard that the older 200k Claude ids (`claude-3-opus-20240229`, `claude-opus-4.1`, `claude-opus-4-5-20251101`) keep their existing caps — so the rejected broad-pattern fix cannot be reintroduced silently.

# v0.15.25 (2026-08-15)

## Fix: DeepSeek V4 is text-only on codebuddy-cn (drop wrong `vision: true`)

- **`open-sse/providers/capabilities.js`:** Set `vision: false` on `codebuddy-cn` → `deepseek-v4-pro` and `deepseek-v4-flash` (previously `vision: true`). Primary evidence is the observed upstream rejection — image-bearing requests to these models returned `400 "unknown variant image_url, expected text"` because the wrong flag kept the translator from stripping `image_url` blocks. Corroborated by models.dev, which reports `modalities.input = ["text"]` for DeepSeek V4 on every provider that publishes it (nvidia, hpc-ai, cortecs, orcarouter, nano-gpt, cloudflare-workers-ai). Written as an explicit `false` rather than an omission so the intent is "unsupported", not "unspecified".
- **Scope:** `codebuddy-cn` was the only provider override carrying the wrong flag — the `nvidia` override and the `*deepseek-v4*` PATTERN entry were already text-only, so no other provider needed a change. Verified by grepping every `deepseek-v4` occurrence in `open-sse/` and `src/`.
- **Regression guard (`tests/unit/capabilities-deepseek-v4-text-only.test.js`):** 6 new tests pin the resolved capability, assert the other caps (reasoning, thinking format, context) survive the fix, and add two family-level invariants — no provider override may grant `vision` to any `deepseek-v4*` model, and the pattern entry must stay text-only — so a future V4 variant is safe by default instead of one 400 away from a hotfix.
- **Version hygiene:** `package-lock.json` was stale at `0.15.21` while `package.json` was `0.15.24`; both are now `0.15.25`. The lockfile was updated manually, then an `npm ci` was run to prove no dependency drift existed beyond the version strings — the tree was already consistent.

# v0.15.24 (2026-08-14)

## Fix: Kiro AWS IAM Identity Center (IDC) Region Resolution & Target Headers

- **AWS CodeWhisperer Region Resolution:** Fixed `KiroExecutor.getOrderedBaseUrls` to extract endpoint regions from `profileArn` and validate against available CodeWhisperer regions (`us-east-1`, `us-west-2`, `eu-central-1`). When an enterprise SSO/IDC portal is configured in non-CodeWhisperer regions (such as `ap-southeast-1`), requests safely default to `us-east-1`, preventing 20-second DNS hangs and fallback 400 errors on social gateways.
- **Header Matching (`X-Amz-Target`):** Attached `X-Amz-Target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse` to all AWS surfaces (`codewhisperer.*.amazonaws.com` and `q.*.amazonaws.com`).
- **Snapshot Test Stabilization:** Sanitized dynamic `agentContinuationId` in golden snapshot tests.

# v0.15.23 (2026-08-14)

## Fix: Restore Kiro Category to OAuth and Configure Dual-Auth Modes in Provider Registry

- **Kiro Provider Category & Dual-Auth Modes:** Restored `category: "oauth"` (previously `free`) and configured `authType: "oauth"` with `authModes: ["oauth", "apikey"]` in `open-sse/providers/registry/kiro.js`.
- **Dashboard UI & OAuth Modal:** Restored Kiro under the **OAuth Providers** group on `/dashboard/providers` and fixed `/dashboard/providers/kiro` to properly display the **Login with Kiro (OAuth)** action and `KiroOAuthWrapper` modal (AWS Builder ID, Social login Google/GitHub, CLI auto-import, and Profile ARN configuration).
- **Invariants & Automated Tests:** 100% test suite passing (202 test files, 1,907 tests), valid request format snapshots preserved.

# v0.15.22 (2026-08-14)

## Feature: Port Upstream v0.5.50–v0.5.55 Features, Enterprise SAML 2.0 SSO & Security Hardening

- **Enterprise SAML 2.0 SSO:** Added end-to-end SAML 2.0 single sign-on integration with SP metadata generation (`/api/auth/saml/metadata`), assertion signature verification, `InResponseTo` replay validation, encrypted state cookies, rate-limiting brute-force lock on ACS (`/api/auth/saml/acs`), and flexible claim/attribute mappings (`pickSamlEmail`, `pickSamlDisplayName`).
- **Socket Peer Token Proof Hardening:** Added cryptographically random boot secrets and trusted peer token validation (`custom-server.js`, `src/lib/auth/trustedPeer.js`) to prevent reverse proxy and header spoofing (`x-9r-real-ip`, `x-9r-peer-token`, `x-9r-via-proxy`) on loopback dashboard guard checks.
- **Kiro Executor Hardening & Session Replay:** Implemented reactive HTTP 400 `content_length_exceeds_threshold` shrink-retry loop with geometric history turn dropping and current-turn head+tail truncation. Added `kiroSessionReplay` store for deterministic `msg0` caching and preserved valid tool turn pairings.
- **OpenCode Executor Unified Routing:** Consolidated Zen and Go transports inside `OpenCodeExecutor` with dynamic URL routing, automatic model mapping between Anthropic `/messages` and OpenAI `/chat/completions`, official client headers, and token injection on free reasoning models.
- **Provider & Model Catalog Enhancements:** Added GLM-5.3, Alibaba Token Plan (`alitp-intl`), Fish Audio TTS, Kimchi dual-authentication support, Claude 1-hour quota caching and force refreshing, and Hermes vision detection.
- **Invariants Preservation & Verification:** 100% test suite passing (202 test files, 1,907 unit tests), zero regressions on RTK Token Saver, and safe SQLite single-writer batch concurrency mutex.

# v0.15.21 (2026-08-14)

## Fix: Test Suite Stabilization, DBA Retention & React 19 Compiler Lint Warnings

- **DBA Batch Flush & Retention:** Added `flushPromise` mutex in `src/lib/db/repos/requestDetailsRepo.js` to ensure parallel calls to `flushToDatabase()` / `flushRequestDetailsBuffer()` reliably await in-flight batch writes. Updated unit test timestamps dynamically to prevent premature retention pruning.
- **SQLite Concurrency & Deduplication:** Conditioned `existing` duplicate query in `src/lib/db/repos/usageRepo.js` on `(entry.dedup || entry.dedupKey)`, boosting write throughput and eliminating dropped writes under heavy concurrent load.
- **React 19 Hooks & Compiler Lint Cleanups:** Refactored state synchronization and derived loading states in `PricingModal`, `RequestLogger`, `ModelSelectModal`, `OAuthModal`, `DonateModal`, `EditConnectionModal`, `LanguageSwitcher`, `AddCustomEmbeddingModal`, `CursorAuthModal`, `ChangelogModal`, `McpMarketplaceModal`, `useModelContextWindows`, and `pricing/page.js`.
- **Unit & Build Gates:** 100% test suite passing (185 test files, 1,773 unit tests), 0 ESLint errors across components, and full Next.js production build passing.

# v0.15.20 (2026-08-14)

## Fix: Antigravity Gemini 3.7 Flash Upstream Mapping & Anonymous Default Exports

- **Upstream Model Mapping:** Added `upstreamModelId: "gemini-3.6-flash-*"` mapping to `gemini-3.7-flash-*` in `open-sse/providers/registry/antigravity.js` and `open-sse/executors/antigravity.js` so client requests for Gemini 3.7 Flash route seamlessly to Google Cloud Code backend without 404 entity not found errors.
- **Executor Model Resolution:** Updated `open-sse/handlers/chatCore.js` to dispatch with resolved `effectiveModel` (`upstreamModel || model`) across executor execute and retry calls.
- **ESLint & ESM Refactor:** Assigned anonymous object literals to named variables before `export default` across all 95+ provider registry files.

# v0.15.19 (2026-08-14)

## Feature: Add Gemini 3.7 Flash Support to Antigravity Provider

- **Antigravity Registry:** Added `gemini-3.7-flash-high`, `gemini-3.7-flash-medium`, and `gemini-3.7-flash-low` to Antigravity provider model registry (`open-sse/providers/registry/antigravity.js`).
- **Quota Tracking:** Included Gemini 3.7 Flash model tiers in Antigravity usage tracker (`open-sse/services/usage/google.js`) for dashboard quota bars.
- **Pricing & Routing:** Added canonical pricing and glob pattern fallbacks for Gemini 3.7 Flash variants (`open-sse/providers/pricing.js`).
- **CLI & MITM Support:** Added Gemini 3.7 Flash model aliases and synonym mappings to CLI menus (`cli/src/cli/menus/providers.js`), MITM constants (`src/shared/constants/cliTools.js`), and MITM config (`src/mitm/config.js`).
- **Unit Tests:** Added full test suite in `tests/unit/antigravity-quota-gemini-3.7.test.js`.

# v0.15.18 (2026-08-13)

## Feature: Add NousResearch Provider Registry (PR #280)

- **New Provider Added:** Added NousResearch (`nousresearch`) as an official first-class provider registry entry in 888router (`open-sse/providers/registry/nousresearch.js`).
- **Models Included:**
  - `nousresearch/hermes-4-405b` (Hermes 4 405B)
  - `nousresearch/hermes-4-70b` (Hermes 4 70B)
  - `nousresearch/hermes-3-llama-3.1-405b` (Hermes 3 Llama 3.1 405B)
  - `nousresearch/hermes-3-llama-3.1-70b` (Hermes 3 Llama 3.1 70B)
  - `nousresearch/deephermes-3-llama-3-8b-preview` (DeepHermes 3 Llama 3 8B)
  - `nousresearch/hermes-2-pro-llama-3-8b` (Hermes 2 Pro Llama 3 8B)
  - `nousresearch/nous-hermes-2-mixtral-8x7b-dpo` (Nous Hermes 2 Mixtral 8x7B DPO)

# v0.15.17 (2026-08-13)

## Fix: Controller state safety in pipeStreamWithHead & RTK 64KB Hard Cap (PR #278)

- **Root Cause of Empty/Malformed Response (HTTP 200) Error:** When a client disconnected or a stream was aborted mid-flight, `pipeStreamWithHead` called `controller.error(err)` or `controller.close()` on an already closed stream, throwing `Invalid state: Controller is already closed`. This caused Node.js/Next.js to return an empty/malformed HTTP 200 chunk, triggering `API returned an empty or malformed response (HTTP 200)` in Claude Code CLI.
- **Fix:** Safe `try/catch` wrappers added around `controller.enqueue()`, `controller.close()`, and `controller.error()` inside `pipeStreamWithHead`.
- **RTK Optimization:** Added `RTK_HARD_CAP_BYTES: "65536"` (64KB) in `docker-compose.yml` for 2x larger tool result context room.

# v0.15.16 (2026-08-13)

## Fix: Anthropic SSE format support in comboStreamGuard (PR #276)

- **Root cause of Combo stream drop bug:** `comboStreamGuard` previously only parsed OpenAI format (`choices[0].delta.content`) and Ollama format (`json.response`). When Anthropic SSE format events (`content_block_delta` with `delta.text` / `delta.partial_json`) flowed through, `comboStreamGuard` failed to parse text deltas → `sawText` remained `false` → `comboStreamGuard.isEmpty()` evaluated `true` → combo misclassified stream as empty and dropped the model or failed.
- **Anthropic SSE Format Support:** Added native support for Anthropic SSE format events in `comboStreamGuard`:
  - `delta.text` and `delta.partial_json` inside `content_block_delta` → sets `sawText = true`
  - `delta.thinking` inside `content_block_delta` → sets `sawReasoning = true`
  - `message_stop` and `delta.stop_reason` → sets `sawTerminal = true` and records `finishReason`
- **Tests:** Added Anthropic SSE format stream guard tests in `tests/unit/combo-stream-guard.test.js` (18/18 passed 100%).

# v0.15.15 (2026-08-13)

## Fix: OpenCode free models catalog update & endpoint unavailable handling (PR #272)

- **OpenCode Free Catalog Update:** Added `big-pickle`, `hy3-free`, `nemotron-3.5-lightning-free` to OpenCode free model registry; removed stale/unavailable model IDs (`ling-3.0-flash-free`, `north-mini-code-free`, `laguna-s-2.1-free`).
- **Executor Parameter Resolution:** Fixed `OpenCodeExecutor.buildHeaders` effective model resolution so `Authorization: Bearer public` and Anthropic/OpenAI headers are sent correctly regardless of call signature.
- **Endpoint Unavailable Fallback:** Added `{ text: "endpoint is unavailable", modelError: true }` rule to `errorConfig.js` so combo automatically skips to available free models when upstream endpoints are unavailable.
- **Universal Tool Prompt Denylist:** Added `big-pickle` to `universalToolPrompt.js` denylist to ensure XML tool prompt is injected for free non-tool models.
- **Tests:** 100% tests pass (`tests/unit/opencode-zen-go.test.js`).

# v0.15.14 (2026-08-13)

## Fix: 429+Retry-After when all proxy pools parked, not 404 (PR #270)

- **Root cause:** When every OpenCode proxy pool was parked by 429 `FreeUsageLimitError` backoff, `pickVirtualNoAuthConnection` returned `null` → `chat.js` sent 404 NOT_FOUND → Claude Code showed "model may not exist or you may not have access" instead of retrying.
- **Fix:** `pickVirtualNoAuthConnection` now returns `{ allRateLimited: true, retryAfter }` with the earliest pool reset time → `chat.js` sends 429 + `Retry-After` header → Claude Code retries automatically after the cooldown window.
- **Review fix (Opus HIGH):** Parses actual upstream status from pool `lastError` format `[NNN]: ...` instead of hardcoding 429 — pools parked by 503 (usage_exceeded/suspended relay) or 401 now report the real status code.
- **Tests:** 32/32 proxy pool tests pass (added 503-parked pool test case).
- **Live verified:** 429 + Retry-After: 1200s (was 404 before fix).

# v0.15.13 (2026-08-12)

## Fix: Streamed reasoning-budget retry & inject min max_tokens (PR #265)

- **MoA Decision on 502 empty stream:** opencode free models (deepseek-v4-flash-free) exhaust max_tokens on reasoning → stream ends `content:""` + `finish_reason:"length"` → `comboStreamGuard` misclassifies as `empty` → combo drops model → client sees 502.
- **Streamed reasoning-budget retry:** `comboStreamGuard` now exposes `sawReasoning()` + `finishReason()`. When `guard.isEmpty()` AND `sawReasoning` AND `finishReason === "length"`, `combo.js` SSE branch retries ONCE with `withRaisedMaxTokens(body)` (max_tokens x3, capped 65536) before falling through — mirroring the non-stream path.
- **Min max_tokens injection:** `opencode.js` injects `max_tokens: 2000` in `transformRequest` for `-free` reasoning models when `max_tokens` is absent/undefined from client.
- **Deep research evidence:** 325 `status='empty'` rows in DB (260 opencode), 323/325 with `output_tokens` 95-794 — model *did* generate thinking but stream ended with zero text. Proxy rotation healthy (345/355 success, 97%).
- 68/68 proxy+combo tests pass; review findings fixed (duplicate key, test assertions).

# v0.15.12 (2026-08-12)

## Fix: Proxy rotation stuck on one relay — stale-unavailable pools (PR #260)

- **A single working relay carried every request** while two eligible pools sat idle with `testStatus=unavailable` but no park window. `getProxyPools` sorts by `updatedAt` desc, and an active pool gets its `updatedAt` bumped by every request, so it always sorted first — the loop always picked it. Observed as a 300s stream then client timeouts (retry 6/10).
- **Selection is now healthy-first**, and a stale-unavailable pool (window lapsed, not yet seen working again) is re-admitted **only when no healthy pool remains** — otherwise `clearAccountError` could never fire (the pool is never selected) and every relay would end up quarantined forever → hard outage.
- **Fallback matrix:** zero pools configured → direct; healthy-but-URL-less → direct (config problem); all-stale with no usable URL → exhausted (`null`), not a silent bypass to a raw noauth connection.
- Review-driven over 3 rounds (opus + kr): CRITICAL deadlock closed, invariant verified (`clearAccountError` clears `unavailableUntil`/`testStatus`/`backoffLevel`).

# v0.15.11 (2026-08-11)

## Fix: Combo guard cap-hit stream ending empty (PR #256)

- **A reasoning preamble over 64KB tripped the stream-guard cap.** `comboStreamGuard` set `sawText=true` when the reasoning preamble exceeded `MAX_BUFFER_BYTES` (64KB) and released the head "live" — a don't-stall decision. But a stream whose reasoning alone blew past the cap and then ended with zero real content was thereby classified **non-empty**, so the client got a 200 SSE with nothing usable: `502 empty stream content` on retry loops (`9-deepseek-v4-flash[1m]` retrying 2/10, 3/10...).
- **The cap release now only means "don't stall a long-thinking model"** — an EOF or terminal marker with no text still classifies as empty, so the combo falls through to the next model instead of shipping an unusable 200.
- Regression tests cover cap-hit-then-empty, cap-hit-then-text, and cap-hit-then-terminal; caller verified to consult `isEmpty()` before any byte reaches the client.

# v0.15.10 (2026-08-11)

## Fix: Transient 5xx pools park 30s, not 5s (PR #252)

- **A Vercel relay that returns 504 recovers in ~10-30s, but the status rules carried no `parkMs`** — `markAccountUnavailable` fell back to `cooldownMs` (5s) as the park window, so the relay was handed straight back within seconds. Combo burned the 5s wait, then fell through to the next provider (e.g. ollama, which 429'd) while the relay was still down.
- **Suspend-class (503 USAGE_EXCEEDED) keeps its 30-min park; transient 5xx (503/502/504) now parks 30s.** `cooldownMs` stays 5s so the hop to the next pool within one request is not stalled.
- **Load-time invariant enforced:** `parkMs` must exceed `cooldownMs` on the same rule, so a future edit cannot invert them and reintroduce the loop silently.
- **Behavior test added:** a transient-5xx pool is parked ~30s and selection keeps skipping it for the whole window.

# v0.15.9 (2026-08-11)

## Fix: Rotation kept handing back a proxy relay whose host had suspended it (PR #248)

- **A quota-suspended relay is now parked for 30 minutes instead of 2 seconds.** Deno Deploy / Vercel answer `503 (USAGE_EXCEEDED) This application is suspended due to usage limits being exceeded` when a relay exceeds its quota, and it stays down until the quota window resets (hours). Rotation was handing the same dead relay back within seconds — measured at 754 picks in 3 hours while a healthy pool sat unused, so roughly half of every combo request was spent failing against a relay that could not answer.
- **Two stacked causes.** (1) `ERROR_RULES` are first-match-wins, and the suspend body also matches `{ text: "usage limit", backoff: true }`, so a suspended relay was classified as an escalating rate limit. (2) `markAccountUnavailable` passed a hardcoded `backoffLevel` of 0 and persisted nothing, so every failure resolved to the level-1 value (2s) forever.
- **The two clocks are now separate**, which is what conflating them broke: `cooldownMs` stays short (5s) because it only paces the hop to the next pool inside one request — combo waits it out before falling through — while the new `parkMs` (`POOL_SUSPEND_PARK_MS`, 30 min) governs how long the pool is held out of *later* rotations.
- **Pool health lives on the `proxyPools` row** (park window + backoff level), since a virtual `noauth:` pool connection has no `providerConnections` row to hold it. `clearAccountError` resets it once a request through that pool succeeds, and pool selection is read-only — eligibility is decided by the park window alone, so nothing that writes a status can un-park a relay early.
- **A failed park write logs at error level**, because an unparked pool is handed straight back on the next request; at warn it blended into normal traffic and the fix could be silently inert under DB pressure.

# v0.15.8 (2026-08-10)

## Fix: Streaming reply truncated-to-empty on reasoning models (PR #243)

- **Fall through when a combo model streams reasoning-only then ends empty** — deepseek/kimi models could exhaust max_tokens on the thinking phase and end the SSE stream with `finish_reason: length` + zero text content. handleComboChat treated any 2xx as success, so the client got a 200 SSE with nothing usable ("answer got cut off").
- **New `comboStreamGuard`** buffers the stream head until it sees real text or a terminal event, then releases it untouched (latency = first-chunk only). Empty streams fall through to the next combo model.
- **Ollama NDJSON + split-chunk + clean-EOF handling** so combo members in different stream formats are detected correctly; mid-stream network cuts are not misread as empty.
- **Empty streams no longer recorded as billable STREAM USAGE.**

# v0.15.7 (2026-08-08)

## Fix: Savings Report Chart (PR #239)

- **Restore id/timestamp/model/provider in the savings-summary SELECT** — the columns-only OOM fix (#235) dropped them, so dayKey fell to 'unknown' and the daily series chart showed 'No daily series yet' with recent[] nulls. The 4 base columns are lightweight (~240KB/2000 rows) and keep the OOM fix intact (data blob still excluded).

# v0.15.6 (2026-08-08)

## Fix: Savings Report OOM (PR #235)

- **Stop SELECTing the 870MB-2.9GB data blob** in getTokenSaveSummary — was materializing the whole blob in the Node heap → FATAL OOM → HTTP 000 + container restart. Now columns-only aggregate (18ms/2000 rows). filterHits/diag/meta dropped from the report (re-add later via targeted query if the dashboard needs chips).

# v0.15.5 (2026-08-07)

## Fix: Proxy-Pool Retry Scope (PR #231)

- **isServerError5xx scope fix**: the proxy-pool 5xx retry-skip (from #216) was computing the check outside `tryRetry` where `statusKey` is undefined → always false → the optimization never fired (in-executor 5xx retries still ran, ~9s per 503). Found by agy (Claude Opus) review. Now evaluated per-call inside `tryRetry` — pool rotation happens immediately (~8s saved per 503 as intended).

# v0.15.4 (2026-08-07)

## Performance & Dependency Updates

- **Savings report DBA fix** (PR #227): hot stats extracted to real columns at write time + covering index — report query index-only, ~6.2s → <1s.
- **Next.js 16.3.0** (PR #225): ~90% less dev memory, faster builds/rendering, LTS security fixes.

# v0.15.3 (2026-08-07)

## Fix: Combo Empty-Body & Reasoning Budget (PR #221)

- **HTTP 200 empty/malformed response fix** (issue #219): when a proxy-pool upstream returns 200 with an empty/stalled body, combo.js now treats it as failure (falls through to next model) and streamingHandler.js synthesises an error instead of piping an empty stream — stops Claude Code 'API returned an empty or malformed response (HTTP 200)'.
- **Reasoning max_tokens exhaust fix** (issue #220): reasoning models (deepseek/kimi) that burn the whole budget on thinking now retry once with a raised max_tokens before falling through.

# v0.15.2 (2026-08-07)

## Performance: Combo Latency (Executable Proxy-Pool Retry)

- **Skip in-executor 5xx retry for proxy-pool requests** (PR #216): when a request goes through a proxy pool and the pool returns 503/502/504/500, the executor no longer retries the SAME pool up to 3x (~4-9s wasted) — the error surfaces to chat.js immediately so pool rotation kicks in ~1s instead of ~9s. Non-pool (saved-connection) providers keep the normal retry behavior.
- Expected latency: ~8s saved per 503, worst-case combo requests ~109s → ~77s.

# v0.15.1 (2026-08-06)

## Fix: Proxy Pool Rotation (Combo)

- **Rotate proxy pools on 503 before combo switches provider** (PR #212): virtual noAuth proxy-pool connections now carry `connectionId` so the account layer rotates through remaining pools when one relay returns 503/429 (e.g. Deno relay USAGE_EXCEEDED) instead of combo switching to the next provider while other pools are idle.
- **errorConfig**: added status 503/502/504 + text `usage_exceeded` rules with 5s cooldown so transient relay-suspend errors rotate quickly instead of a 30s default stall.

# v0.15.0 (2026-08-06)

## Upstream Port & Combo Reliability

- **Port 8 upstream features** from decolua/9router v0.5.50 (PR #207):
  - Antigravity: preserve image-only user messages, Gemini 3.6 Flash quota bars, IDE constants (ANTIGRAVITY_IDE_VERSION/USER_AGENT)
  - Codex-tui/Codex Desktop client detection
  - TokenRouter provider with accurate pricing (120+ models)
  - Remove global Claude header cache, gate anthropic-beta per model
  - Qoder PAT (Personal Access Token) support + SSE stream hang fix
  - ENABLE_REQUEST_LOGS env override
  - Video endpoint path fix (/v1/videos/generations)
- **Combo 429 fix**: when all combo models are quota-limited, return 429+retry-after instead of switching to a shared-quota model (PR #207)
- **Fix Docker build**: remove duplicate ANTIGRAVITY_IDE_USER_AGENT declaration (PR #208)

# v0.14.17 (2026-08-05)

## UI & Data Model Enhancements (Synced Model Badge & Persistence)

- **Synced Model Badge (Blue Badge)**: Updated provider model table UI (`ModelsTable.js`) to display a distinct blue `synced` badge (`bg-blue-500/10`) for models automatically imported from upstream provider endpoints. Manual custom models retain the amber `custom` badge (`bg-amber-500/10`).
- **Database Persistence & Delete Handler Fix**: Persisted `source` field in `addCustomModel` (`aliasRepo.js`) and updated `page.js` delete handler branching to support deletion of synced custom model rows.

# v0.14.16 (2026-08-05)

## Maintenance & Code Style Refactoring

- **TokenRouter Named Variable Export**: Refactored `tokenrouter.js` provider registry from anonymous default export to named variable binding export (`const tokenrouter = { ... }; export default tokenrouter;`), eliminating ESLint `import/no-anonymous-default-export` warning.

# v0.14.15 (2026-08-05)

## TokenRouter Integration & Multi-Model Review Fixes

- **TokenRouter Provider Integration**: Full support for TokenRouter (`tokenrouter.js`), registered in `APIKEY_PROVIDERS` as category `apikey`, supporting LLM, Embedding, and Image generation with passthrough models.
- **TokenRouter Live Models Endpoint**: Added `tokenrouter: createOpenAIModelsConfig("https://api.tokenrouter.com/v1/models")` to `PROVIDER_MODELS_CONFIG` in `src/app/api/providers/[id]/models/route.js` for live model sync.
- **Venice Route Regression Fix**: Restored `venice` mapping in `PROVIDER_MODELS_CONFIG` to resolve live listing regression.
- **Anthropic-Beta Header Deduplication**: Deduplicated Anthropic-Beta flags using `Set` in `DefaultExecutor.buildHeaders()`.
- **TokenRouter Logo Asset Optimization**: Added official TokenRouter logo asset at `public/providers/tokenrouter.png` optimized to 256x256 (10.6 KB).
- **Automated Verification**: Created `tests/unit/tokenrouter-provider.test.js` unit test suite (48/48 tests PASS 100%).

# v0.14.14 (2026-08-05)

## Upstream 9Router (v0.5.50) Enhancements & Bug Fixes

- **Preserve Image-Only Messages (`a7941dda`)**: Updated `hasValidContent()` in `claude.js` to accept `IMAGE` and `DOCUMENT` content blocks so vision turns without accompanying prompt text are preserved rather than dropped.
- **Antigravity IDE OAuth Header Fingerprint (`35f86e58`)**: Scoped `ANTIGRAVITY_LOAD_CODE_ASSIST_HEADERS` to Antigravity's `loadCodeAssist` and `onboardUser` endpoints to prevent Google anti-abuse systems from blocking `cloudaicompanionProject` provisioning.
- **Gemini 3.6 Flash Quota Tracker (`42c691b3` + `b11be8be`)**: Added `gemini-3.6-flash-high/medium/low` to `importantModels` in Google usage tracker and registered in Antigravity provider registry so usage bars render on dashboard.
- **Codex TUI & Desktop Passthrough Detection (`cd13d904`)**: Updated User-Agent regex in `clientDetector.js` to recognize `codex-tui` and `Codex Desktop` native Codex clients without touching NoAuth proxy rotation.
- **Model-Scoped Anthropic-Beta Headers (`13ed1456`)**: Added `selectAnthropicBeta(model)` helper in shared provider utils and wired dynamic beta headers across BaseExecutor and DefaultExecutor.
- **TokenRouter Provider Support (`41588bea` + `b4808929`)**: Added `tokenrouter.js` provider registry, pricing definitions, thinking config, and registered in registry index.
- **Qoder PAT Support (`d433c0b2` + `1eb37db3`)**: Wired `resolveQoderCredentials` into `qoderModels.js` and `QoderExecutor.execute` to support PAT (`pt-...`) exchange to job tokens.
- **`ENABLE_REQUEST_LOGS` Env Var Override (`3fab15ae`)**: Made filesystem request logging check `process.env.ENABLE_REQUEST_LOGS` dynamically in `requestLogger.js` without clobbering SQLite dual retention.
- **Tests**: Added `antigravity-quota-gemini-3.6.test.js`, extended `bugs-toClaude-context.test.js`, verified 100% PASS across full 43-test suite.

# v0.14.13 (2026-08-05)

## Fixes & Polish (Grok Review Feedback)

- **`models.dev` Stale-on-Error Cache**: `loadModelsDevIndex` now returns stale cached data on network/HTTP errors with soft TTL backoff, preventing fallback to static tables during temporary network outages.
- **Throttled Observability Time Prune**: `requestDetailsRepo` time-based retention pruning is now throttled to at most once per 5 minutes to eliminate SQLite write amplification on high-frequency flush paths.
- **Config `0` Value Support**: Replaced `||` with `parseNum` helper so `0` / `"0"` retention & maxRecords settings are respected instead of falling back to default values.
- **Tests**: Extended `models-dev-modality.test.js` and `request-details-retention.test.js` with stale-on-error and prune throttling test cases.

# v0.14.12 (2026-08-05)

## Fixes (Model Capability Sync + Transient 500 + Multi-arch Deploy + Savings Retention)

- **Kiro context sync drops upstream window**: `resolveKiroModels` now surfaces `capabilities.contextWindow` on every variant (mirrors kimchi), and the dashboard dynamic-cap extractor reads `contextLength` — so new model generations (e.g. `kr/claude-opus-5` = 1M) resolve correctly without a per-model static-table patch. Static `claude-opus-5` entry added as safety net. (#194)
- **Kiro 500 `MODEL_TEMPORARILY_UNAVAILABLE` not retried**: added `500` to `DEFAULT_RETRY_CONFIG` (2 attempts) and classified the Kiro reason as a model-level error so combos skip to the next model instead of futilely rotating accounts. (#195)
- **Docker image was arm64-only**: `docker-publish.yml` now builds `linux/amd64,linux/arm64` (multi-arch manifest) so anyone can self-host on x86_64 VPS/cloud, not just Apple Silicon. Compose + `.env.example` + deployment docs updated (SEARXNG_SECRET required, build-from-source option). (#196)
- **Savings report 30d returned same data as 7d**: requestDetails retention was COUNT-based (dropped everything older than ~2 days). Changed to **time-based** (keep `OBSERVABILITY_RETENTION_DAYS`, default 30) so 24h/7d/30d reports have real data.
- **Tests**: `kiro-models-context`, `retry-500-config`, `request-details-retention` (new); extended `capabilities-opus-context`, `combo-routing`.

# v0.14.11 (2026-08-03)

## Features (Proxy Pool Auto-Rotate for noAuth Providers)
- **Auto-rotate proxy pools on failure**: noAuth/free providers (opencode, etc.) now rotate across active proxy pools automatically when a pool returns 429/402/5xx — matching the long-available "Auto-Rotate All Active Pools" UI option that was previously unimplemented.
- **Root cause**: `markAccountUnavailable` hard-blocked fallback for the `noauth` id, so a rate-limited pool surfaced to the client instead of trying the next pool.
- **`pickVirtualNoAuthConnection()`**: picks the next non-excluded pool, single-pool resolve (no N+1), distinct `noauth:<poolId>` virtual ids so chat.js's account-fallback loop rotates; specific-pool + direct-fallback modes preserved (backward compatible).
- **Tests**: `tests/unit/noauth-proxy-rotate.test.js` (13 cases) incl. a full chat-fallback-loop integration (pool A 429 → B success → both fail → null).

# v0.14.10 (2026-08-02)

## Features (Self-Hosted Skill Links)
- **Skill links served from this gateway**: `/api/skills/raw/<id>` serves SKILL.md directly (no GitHub raw) — dashboard cards + all 10 SKILL.md cross-refs now point at the gateway.
- **Serve-time absolutization**: SKILL.md stores cross-skill refs relative (portable source); raw route rewrites to absolute URLs using a trusted origin (`NINEROUTER_PUBLIC_URL`), failing closed in production when unset (no Host-header origin trust).
- **Hardened raw route**: traversal/symlink-safe id resolution (regex whitelist + realpath + path containment), `text/markdown` + `nosniff` + `no-store`.
- **`.env.example`**: documents `NINEROUTER_PUBLIC_URL` for reverse-proxy/tunnel deploys.
- **Tests**: `tests/unit/skill-refs.test.js` (16 cases) — rewrite, already-absolute untouched, `$` safety, prod fail-closed, dev fallback.

# v0.14.9 (2026-08-02)

## Features (Dynamic Skills Catalog + SearXNG Skill)
- **Dynamic skills catalog**: `/dashboard/skills` now fetches `/api/skills` which scans `./skills/<id>/SKILL.md` at request time — no hardcoded list to keep in sync. YAML frontmatter parsed (name/description/endpoint), entry-first then alphabetical; `SKILLS_DIR` env override + cwd fallback; errors don't leak internal paths.
- **SearXNG skill**: added `skills/searxng/SKILL.md` (self-hosted SearXNG search via `/v1/search`).

## DevOps (Reproducible Docker + Compose Healthcheck + CI Hardening)
- **Reproducible builds**: Dockerfile `npm install` → `npm ci`; commit `package-lock.json` (removed from `.gitignore`).
- **Compose**: liveness healthcheck for 888router (via `/api/version`); add SearXNG service, point `SEARXNG_BASE_URL` at the compose service name (fixes localhost-in-container 502).
- **CI hardening**: concurrency guard + least-privilege permissions; `setup-node cache:npm` + `npm ci`; docker cache → `type=gha`.
- **Security**: `SEARXNG_SECRET` required (no known-in-git default); SearXNG internal-only (no host port).

# v0.14.8 (2026-08-02)

## Features (Universal Tools Toggle + Env Kill-Switch)
- **Universal Tools UI Toggle**: Dashboard → Profile → "Universal Tools" toggle (Auto/Off) controls the universal tool shim path at runtime without a restart (persisted to DB settings `universalToolsMode`).
- **Env Kill-Switch**: `UNIVERSAL_TOOLS_MODE=off` forces the shim path off and locks the UI toggle read-only. Env-set (`off`|`auto`) is authoritative; unknown env values treated as unset. Single source of truth = `resolveUniversalToolsMode()`.
- **Trust-boundary validation**: PATCH `/api/settings` validates `universalToolsMode` to `auto`|`off`, returns 403 when env kill-switch set.

## Fixes (Close Shim-Allocated Tool Use Blocks on Abort)
- **"Content block not found" fix**: moved universal tool shim upstream of `pipeWithDisconnect` so the disconnect scanner sees shim-allocated `tool_use` blocks; synthesized Claude abort terminal closes open blocks before `message_stop`.
- **Chunk-safe abort scanning**: `scanForBlockEvents` uses chunk-boundary line buffer, long-lived `TextDecoder` (`stream:true`), 1MB cap, flushes pending data on abort.
- Unit tests for abort terminal + universal tools mode precedence.

# v0.14.7 (2026-08-02)

## Fixes (Stream Shim Terminal — Close Open Blocks on Abort)
- Close shim-allocated `tool_use` blocks before `message_stop` on upstream abort / client disconnect (eliminates "Content block not found").

# v0.14.4 (2026-07-31)

## Fixes (Tool Name Fallback & OpenAI Translation Fix)
- **Tool Name Fallback in Claude-to-OpenAI Translation**: added `tool.function.name` fallback in `claudeToOpenAIRequest` (`claude-to-openai.js`) and `filterToOpenAIFormat` (`openai.js`), preventing tool name loss and 422 errors (`tools[0]: missing field 'name'`) when clients send OpenAI-shaped tools.

# v0.14.3 (2026-07-31)

## Fixes (Universal Anthropic Request Format Normalization)
- **Unconditional Tool Schema Folding**: unconditional conversion of all tool definitions (`function.name`, `function.parameters`) into native Anthropic `{ name, description, input_schema }` format for all provider targets (including `claude`).
- **Tool Choice Normalization**: mapped string `tool_choice="none"` to Anthropic `{ type: "none" }` and OpenAI function objects into `{ type: "tool", name: "..." }`.
- **System Prompt Text Extraction**: extracted `text` or `content` properties from system prompt objects without JSON stringifying.

# v0.14.2 (2026-07-31)

## Fixes (Empty Assistant Content Array Prevention)
- **Empty Assistant Block Prevention**: added safety fallback in `claude.js` so assistant messages with empty content arrays `[]` automatically receive a valid `{ type: "text", text: " " }` block before upstream Anthropic dispatch, preventing `API Error: Content block is not a text block` when filtering out whitespace-only assistant text blocks.

# v0.14.1 (2026-07-31)

## Fixes (Anthropic Content Block Strict Normalization)
- **Stray `content` Field Stripping**: added `normalizeClaudeContentBlock` helper in `claude.js` to ensure `type: "text"` blocks never carry stray `content` fields (e.g. `{ type: "text", text: "...", content: "..." }`) which triggered Anthropic `API Error: Content block is not a text block`.
- **Unknown Block Fallback**: automatically normalizes any non-standard or unrecognized block objects sent by Claude Code into clean `{ type: "text", text: "..." }` blocks before upstream Anthropic dispatch.

# v0.14.0 (2026-07-31)

## Fixes (Stream Tool Shim Loose JSON Auto-Repair Integration)
- **Tool Arguments JSON Auto-Repair**: integrated `repairAndParseJson` into `emitToolCallChunk` inside `streamToolShim.js` to automatically repair loose JSON (trailing commas, unescaped quotes) in streamed tool calls and preserve raw partial JSON arguments on parse error instead of discarding them as `{}`.

# v0.13.9 (2026-07-31)

## Fixes (DeepSeek DSML Stream Tag Detection & State Preservation)
- **DSML Opening Tag Detection (`<｜｜DSML｜｜>`, `<｜｜>`)**: updated `HAS_OPEN_TOOL_TAG` and `extractUnclosedBuffer` in `streamToolShim.js` to detect DeepSeek/Kimi DSML opening tags.
- **Buffer State Maintenance**: reset `textBlockClosed = false` on text buffer overflow to maintain accurate Claude content block index state.
- **Error Flag Preservation**: preserved `is_error` flag in `tool_use` content blocks when `tc.is_error` is set.

# v0.13.8 (2026-07-31)

## Governance & CI/CD Cleanliness
- **Project Rule Governance**: committed `AGENTS.md` and `.agents/` rules (7-Step End-to-End CI/CD Pipeline SSOT & Graphify rules).
- **Git Hygiene**: added `.squish/` and `Reviewing Past Pull Requests.md` to `.gitignore` to keep working directory clean.

# v0.13.7 (2026-07-31)

## Fixes (Universal Tool Engine Pipeline Integration)
- **Universal Tool Attachment Gate**: updated `streamingHandler.js`, `nonStreamingHandler.js`, and `sseToJsonHandler.js` to attach `createStreamToolShimTransformStream` and `parseUniversalToolCalls` whenever tools exist in the request (`body.tools` or `declaredTools`), ensuring models claiming native tool capability (e.g. DeepSeek V3/R1/V4, Ollama, OpenCode) never leak raw `<tool_call>` / `</｜｜DSML｜｜>` XML markup tags into user responses.

# v0.13.6 (2026-07-31)

## Fixes (DeepSeek DSML & Anthropic Content Block Normalization)
- **DeepSeek DSML Markup Tool Parsing (`</｜｜DSML｜｜>`)**: updated `parseUniversalToolCalls` and `streamToolShim` regex engines to recognize DeepSeek DSML closing tags (`</｜｜DSML｜｜>`, `</｜｜>`), preventing raw XML/DSML tool call tags from leaking to user responses.
- **Anthropic Content Block Normalization (`Content block is not a text block`)**: normalized un-typed system objects, `tool_result` internal content arrays, and `ROLE.TOOL` / `ROLE.USER` messages into strict `{ type: "text", text: "..." }` blocks before upstream Anthropic API dispatch.

# v0.13.5 (2026-07-31)

## Fixes (Multi-Model Code Review: Grok 4.5)
- **Fusion Judge Model Selector Fix**: pass `modelAliases` to the Judge model select modal so fusion judge picker lists the full model set.
- **Enabled-Only Provider Filtering**: `ModelSelectModal` now filters to enabled connections only (`isActive !== false`) before applying `kindFilter`.
- **Disabled Model Matching by `value`**: disabled-model filtering now matches both `m.id` and `m.value`, fixing stale/disabled combo entries still appearing in pickers.

# v0.13.4 (2026-07-31)

## Per-Provider Dynamic MCP Setup Feature
- **Per-Provider MCP Setup Icon & Modal**: added `smart_toy` MCP Setup button to every Provider card across Media Providers (Web Search, Web Fetch, Text to Speech, Speech to Text, Image, Embedding).
- **Dedicated Provider AI Prompts**: clicking any provider's MCP button opens `ProviderMcpSetupModal` generating a clean, tailored AI Prompt specifically for THAT provider's MCP server endpoint.

# v0.13.2 (2026-07-31)

## Fixes & Multi-Model Code Review (Grok 4.5 & GLM 5.2 Verified)
- **Dynamic MCP Origin & SSOT Naming**: dynamically derive MCP SSE URLs from runtime origin, align Server keys to `888router-web-search`, and add explicit JSON key merging instructions to `aiPrompt` to prevent AI assistants from overwriting existing configuration files.

# v0.13.1 (2026-07-31)

## Features & UI Improvements
- **AI Setup Prompt & MCP Configuration in Manual Config Modal**: added a copyable `🤖 AI Setup Prompt` and `~/.mcp.json` configuration block into the Manual Configuration modal under CLI Tools, allowing users to copy a single prompt for their AI Assistant to auto-configure 888router base URL and MCP tools!

# v0.13.0 (2026-07-31)

## Features & UI/UX Redesign
- **Redesigned NoAuthProxyCard UI/UX**: replaced conflicting dropdowns with clear, intuitive Proxy Routing Strategy controls, contextual algorithm selectors, and a live glassmorphism status banner (`Current Routing Status`).

# v0.12.9 (2026-07-31)

## Fixes & Code Review Improvements (Grok 4.5 Verified)
- **Settings Cleanup & Persistence**: fixed empty override cleanup logic for `rotationStrategy` in `NoAuthProxyCard` so default values do not accumulate stale keys in settings.
- **UI Error Rollback & Safe Parsing**: added automatic UI state rollback if setting updates fail, and handled JSON parsing safely.
- **UI Copy Alignment & Neutral Styling**: aligned helper text copy and info box styling with neutral design tokens.

# v0.12.8 (2026-07-31)

## Features & UI Enhancements
- **Rotation Strategy & Active Proxy Pools Status Box**: added `Rotation Strategy` dropdown (`Round-robin`, `Random`, `Fill-first`), helper text, and live active proxy pools status box (`Rotating through all X active pools in order`) in `NoAuthProxyCard` to match 9Router upstream UI.

# v0.12.7 (2026-07-31)

## Features & UI Enhancements
- **NoAuthProxyCard Test Connection Button**: added a dedicated `Test Connection` button and real-time status badge (`Connected & Valid` / `Connection Failed`) directly inside `NoAuthProxyCard` for free providers like OpenCode Zen, allowing instant 1-click verification of connection & Proxy Pool IP routing.

# v0.12.6 (2026-07-31)

## Fixes & OAuth Enhancements
- **No-Auth Provider OAuth Exclusion**: updated `isOAuth` evaluation logic in provider detail page to exclude `noAuth` free providers (such as OpenCode Zen), preventing accidental OAuth flow triggers that led to `Error: Unknown provider: opencode`.

# v0.12.5 (2026-07-31)

## Fixes & UI Enhancements
- **OpenCode Zen Display Name & Shared Logo**: set display name of free OpenCode provider to `OpenCode Zen` (with aliases `oc`, `opencode`, `opencode-zen`, `zen`), removed duplicate registry file, and unified the OpenCode logo image across `OpenCode Zen` (Free) and `OpenCode Go` (API Key).

# v0.12.4 (2026-07-31)

## Fixes & Model Cleanups
- **OpenCode Free Models Filtering**: updated `Available Models` for `OpenCode` and `OpenCode Zen` to display only free models (`*-free`), removing paid subscription models which belong exclusively to `OpenCode Go`.

# v0.12.3 (2026-07-31)

## Fixes & UI Enhancements
- **Connections Card & Add Connection UI**: enabled rendering of the Connections Card and `Add Connection` button for no-auth free providers (such as OpenCode Free and OpenCode Zen), allowing users to create multiple connection entries with individual Proxy Pools.
- **Proxy Pools Page Link**: added a direct hint and link to `/dashboard/proxy-pools` in `NoAuthProxyCard` when no active proxy pools exist.

# v0.12.2 (2026-07-31)

## Features & Enhancements
- **OpenCode Provider Separation**: separated OpenCode providers into distinct entries:
  - `opencode` (OpenCode Free / Public mode): `category: "free"`, auto-displays `Ready / Connected` status by default, supports connection testing & proxy pool binding.
  - `opencode-zen` (OpenCode Zen Free mode): `category: "free"`, auto-displays `Ready / Connected` status.
  - `opencode-go` (OpenCode Go API Key): `category: "apikey"`, requires OpenCode Go API key.
- **Connection Test & Validate Probes**: added active probes for `opencode` and `opencode-zen` targeting `https://opencode.ai/zen/v1/models` in `/api/providers/validate` and connection test utils.

# v0.12.1 (2026-07-30)

## Fixes & Enhancements
- **OpenCode Proxy Pool Connection Fix**: allowed creating and saving connections for no-auth/free mode providers (such as OpenCode Free) without requiring an API key, enabling custom Proxy Pool binding. Added Proxy Pool selector dropdown in `EditConnectionModal.js`.
- **Anthropic System Content Block Normalization**: fixed `API Error: Content block is not a text block` by normalizing system string/array inputs to strict `{ type: "text", text: "..." }` blocks in `prepareClaudeRequest` and `openaiToClaudeRequest`.

# v0.12.0 (2026-07-30)

## Features & Improvements
- **Universal Tool Engine**: introduced Universal Tool Engine for non-native models, supporting forced SSE-to-JSON and stream shim transform stream.

# v0.11.1 (2026-07-30)

## Fixes & Enhancements (Context Pruner Hardening)
- **Initial System Instructions & Skills Protection**: marked initial conversation turn group (`isInitial`) to ensure system prompt, skills (`<skills>`), tool definitions (`<tools>`), and workspace context are NEVER dropped during history pruning.
- **Tool Result Token Estimation**: updated `estimateRequestTokens` to recursively count `item.content` and `item.output` strings (including 50,000+ char tool outputs), preventing false under-estimates that caused upstream 400 Context Length Exceeded errors.
- **Consecutive Role Alternation Safety**: prepended tombstone notice directly into first remaining `user` message turn, avoiding standalone `user` -> `user` role duplication that triggered Anthropic & Gemini 400 Bad Request errors.
- **Nested Payload Target Support**: resolved target array accessor for nested `request.contents` (Google AI SDK / Gemini format), ensuring nested request bodies are correctly pruned.

# v0.11.0 (2026-07-30)

## Features & Improvements
- **Optimization Savings Dashboard**: new Savings tab showing RTK Compression, AST Pruner, Headroom Proxy, and Response Cache stats with before/after/saved metrics.
- **Cache Hit Tracking**: response cache hits now tracked in requestDetails with aggregate cache hit-rate in token-save-summary API.
- **kr/auto Context Window**: added `auto` to MODEL_CAPABILITIES with contextWindow=1M so combo context resolution isn't capped by undefined members.

## Fixes
- **savedPct Color**: fixed string-vs-number comparison so green `text-success` activates when savings > 0.
- **Period Fallthrough**: `today` and `60d` periods now resolve correctly instead of defaulting to 7d.
- **cacheHit Persistence**: added `cacheHit`/`cacheKey` fields to `buildRequestDetail` so cache tracking actually persists.
- **Cache Hit Request**: uses `extractRequestConfig` instead of hand-built request object for consistency.
- **Null Safety**: added optional chaining throughout OptimizationSavings component to prevent crash on partial API data.

# v0.10.42 (2026-07-29)

## Features & Improvements (P3: Smart Intent-Based Router)
- **Smart Intent-Based Router**: added `open-sse/translator/concerns/intentRouter.js` classifying prompt complexity (Fast vs Heavy vs Standard) and dynamically routing requests to optimal model tiers when opt-in header (`x-888-auto-route: true` or `x-intent: auto|fast|heavy`) is present.
- **Strict Opt-in Allowlist**: restricted auto-routing to verified opt-in headers only, defaulting to requested models 100% when headers are absent.
- **Same-Family Mapping & Word-Boundary Safety**: enforced same-provider mapping (Anthropic ⟷ Anthropic, OpenAI ⟷ OpenAI, Gemini ⟷ Gemini) and regex word boundary checks (`FAST_REGEX` & `HEAVY_REGEX`), eliminating cross-provider hallucinations and false positives.
- **Unit Test Coverage**: added `tests/unit/intent-router.test.js` covering opt-in contracts, same-family mappings, word boundary protection, and safe null model guards.

# v0.10.41 (2026-07-29)


## Features & Improvements (P2: Dynamic AST Soft-Pruner & History Shrinker)
- **AST Soft-Pruner & History Shrinker**: added `open-sse/translator/concerns/astSummarizer.js` to extract AST outlines (function signatures, class definitions, struct interfaces) for JS, TS, Python, Go, and Rust code blocks in middle turns before hard middle-out pruning.
- **Zero-Bloat Invariant**: enforced strict shrink constraint (`result.length < match.length`), ensuring soft AST outlines never expand payload size.
- **Gemini & Multi-Payload Support**: added `msg.parts` array support alongside standard `msg.content` string and content arrays.
- **Unit Test Coverage**: added `tests/unit/ast-summarizer.test.js` pinning language signature extraction, zero-bloat invariant, and soft-only middle turn preservation.

# v0.10.40 (2026-07-29)


## Features & Improvements (P1: RTK v2 & Tool Output Hard-Caps)
- **RTK v2 Hard Caps**: added `applyHardCap` truncation guard in `open-sse/rtk/index.js` capping oversized tool outputs at 32KB (or `RTK_HARD_CAP_BYTES`) with guaranteed length invariants (`out.length <= capBytes && out.length < text.length`), preventing runaway tool outputs from blowing up context budgets.
- **RAW_CAP Bypass Safety**: enforced hard caps even when tool outputs exceed `RAW_CAP` (>10MB), ensuring deterministic token composition for massive command logs and git diffs.
- **Gemini Contents Format Support**: added `compressGeminiFormat` supporting Gemini/Antigravity `functionResponse` and tool parts while preserving object structure.
- **Unit Test Coverage**: added dedicated test suite `tests/unit/rtk-v2-caps.test.js` pinning length invariants, object structure preservation, and oversized payload caps.

# v0.10.39 (2026-07-29)


## Features & Improvements (Auto Upstream Prompt Caching Injection & Build Resilience)
- **Auto Prompt Caching Injection**: added `open-sse/translator/concerns/promptCache.js` for automatic `cache_control: { type: "ephemeral", ttl: "1h" }` injection in Claude requests and static system prefix normalization for OpenAI/Codex/Gemini requests (saves up to 90% input token cost).
- **Hardened Caching Logic**: enforced max 4 explicit Anthropic cache breakpoints, excluded `thinking`/`redacted_thinking` content blocks, preserved existing client cache controls, and added unit tests (`tests/unit/prompt-cache-concern.test.js`).
- **Data Dir Build Fallback**: added `ENOENT` error handling to `src/mitm/paths.js` and `src/lib/mitmAliasCache.js` fallback mechanism, ensuring clean Next.js production builds when `/app/data` is unmapped.

# v0.10.38 (2026-07-29)


## Fixes & Improvements (Combo Fallback Classification & Model Capabilities Sync)
- **Combo Model-Error Fallback**: classified permanent model-level errors (`"not supported"`, `"model not found"`, status 404, etc.) as `modelError` — bypassing useless account cycling and triggering immediate combo fallback to the next model without locking fine accounts.
- **Model Capabilities & Pricing Sync**: added `kimi-k3` specs (1M context, vision, thinking, $3/$0.30/$15 pricing) and updated capability pattern matching for Claude 4.5/4.6/thinking variants, DeepSeek v4 vision, and Kimi models.
- **Capabilities Validation Script**: added `scripts/validate-capabilities.mjs` tool for automated cross-referencing against authoritative model specs.

# v0.10.37 (2026-07-28)

## Fixes & Improvements (dataDir Error Handling & Unit Test Coverage)
- **dataDir Error Handling**: restricted `getDataDir` error catch block to `ENOENT`, `EACCES`, and `EPERM` so unrecoverable system errors (e.g. `ENOSPC`) re-throw properly — voravitl
- **Unit Test Coverage**: added `tests/unit/datadir-fallback.test.js` pinning default dir fallback and `ENOSPC` re-throw contract — voravitl

# v0.10.36 (2026-07-28)

## Fixes & Improvements (Responses API Tool Name Accumulation & Unit Test Coverage)
- **Responses API Tool Name Accumulation**: fixed tool name accumulation in `responsesTransformer.js` to use `accumulateToolName` instead of overwriting, supporting split tool name chunks across streaming SSE chunks — voravitl (closes #149)
- **Unit Test Coverage**: added dedicated unit test suite in `tests/unit/tool-call-accumulate.test.js` locking `accumulateToolName()` logic across split, re-echo, snapshot, shorter re-echo, and streaming SSE responses — voravitl (fixes #151)

# v0.10.35 (2026-07-28)

## Features & Improvements (OpenCode Free Models Registry)
- **OpenCode Free Models**: added OpenCode Free models (`deepseek-v4-flash-free`, `mimo-v2.5-free`, `ling-3.0-flash-free`, `nemotron-3-ultra-free`, `north-mini-code-free`, `laguna-s-2.1-free`) to OpenCode default provider registry models list — voravitl

# v0.10.34 (2026-07-28)

## Features & Improvements (OpenCode Dynamic Model Sync Handler)
- **OpenCode Model Sync**: added dynamic model listing handler for `opencode` provider in `/api/providers/[id]/models` route, automatically fetching live models from Zen Free or Zen Go based on connection API key presence — voravitl

# v0.10.33 (2026-07-28)

## Features & Improvements (Unified OpenCode Zen Free & OpenCode Go Provider)
- **Unified OpenCode Provider**: updated `opencode` provider registry and executor to seamlessly support both OpenCode Free (Zen) anonymous mode and OpenCode Go API key authenticated connections — voravitl
- **Stateless Concurrency Architecture**: refactored `OpenCodeExecutor` to be completely stateless to prevent concurrent request race conditions and call-order coupling — voravitl

# v0.10.32 (2026-07-28)

## Features & Improvements (Models Table Deduplication, Search & 1M Combo Suffix)
- **Available Models Table Deduplication & Realtime Search**: deduplicated model rows in `ModelsTable` and `CompatibleModelsSection` by `fullModel`/`id`, added realtime search filter bar with model count, and fixed thinking dropdown formatting — voravitl
- **Dynamic Context Window Sorting**: updated `compareModels` to compute fallback context sizes via `getContextWindow`, ensuring context column sorting works accurately — voravitl
- **Combos 1M Context Badge & Auto-Suffix**: added `1M` purple badge on combo cards with maxContext >= 1M tokens and updated copy action to append `[1m]` suffix automatically for Claude Code — voravitl
- **Docker Builder Safety**: ensured `/app/data` directory exists during Next.js static page prerendering phase in Dockerfile — voravitl

# v0.10.31 (2026-07-24)

## Features & Improvements (Token Savings DB Metering & Dual-Average UI)
- **Context Pruner DB Observability**: captured `prunerStats` (`tokensBefore`, `tokensAfter`, `tokensSaved`, `omittedMessages`) in `pruneMessageHistory` and stored in `requestDetails` JSON blob without DB migration — voravitl
- **Sanitized Execution Payload**: stripped internal tracking keys (`_pruned`, `_omittedTurns`, `_prunerStats`) before upstream executor dispatch — voravitl
- **Dashboard Dual-Average UI**: added Context Pruner card and dual-average explanation note to Token Saver Dashboard — voravitl

# v0.10.30 (2026-07-24)

## Features & Improvements (Comprehensive HealthStore Wiring & Multi-Format Pruning)
- **HealthStore Active Wiring**: wired `healthStore` into `checkFallbackError` and `isAccountUnavailable` to actively isolate failing nodes and enforce layered L1->L2->L3 circuit breakers — voravitl
- **Multi-Format Pruner Token Estimator**: added OpenAI `tool_calls` JSON and Gemini `contents` / `request.contents` support to `estimateRequestTokens` and `pruneMessageHistory` — voravitl

# v0.10.29 (2026-07-24)

## Fixes & Improvements (Adversarial Sub-Agent Audit Refinements)
- **Context Pruner Budget Floor**: fixed budget floor calculation to preserve `70% * contextWindow` minimum for high-maxOutput models like Kimi & Hunyuan — voravitl
- **Claude Wire Tool-Pair Grouping**: extended `groupMessageTurns` to recognize Claude `role: "user"` tool_result blocks atomically, preventing tool chain splits — voravitl
- **Stale Node Cleanup in HealthStore**: added automated pruning of expired node IDs in `isProviderOpen` and `isNodeOpen` — voravitl
- **ProxyAgent Socket Cleanup**: destroy evicted ProxyAgent instances to prevent FD/socket leaks on proxy configuration changes — voravitl

# v0.10.28 (2026-07-24)

## Features & Improvements (4-Phase Ultracode Architecture)
- **Phase 1 (Latency & Media)**: persistent `undici.Agent` HTTP Keep-Alive connection pool in `proxyFetch.js` (`keepAliveTimeout: 30s`, `connections: 100`) — voravitl
- **Phase 2 (Context Pruner)**: tool-pair aware atomic middle-out context pruner (`open-sse/translator/concerns/pruner.js`) preventing history token overflow while strictly keeping `tool_use` and `tool_result` pairs intact — voravitl
- **Phase 3 (Reasoning Gap-Fill)**: unified thinking normalization for Qwen, Kimi, Hunyuan, and Step reasoning tags — voravitl
- **Phase 4 (Health & Circuit Breaker)**: in-memory `MemoryHealthStore` (`open-sse/services/healthStore.js`) and L1->L2->L3 layered circuit breaker preventing single-account 429 quota locks from closing provider nodes — voravitl

# v0.10.27 (2026-07-24)

## Fixes & Improvements
- **LLM Context History (Reasoning Context)**: preserve `reasoning_content` from OpenAI assistant message history into Claude `thinking` blocks in `openaiToClaudeRequest`, preventing loss of model reasoning context — voravitl
- **LLM Token Limits (`max_completion_tokens`)**: support `max_completion_tokens` fallback in `adjustMaxTokens` for modern OpenAI/reasoning models (o1, o3-mini, GPT-4o, GPT-5) — voravitl
- **Combo Auto-Switch**: enable `web_search` tool capability detection and optimize `reorderByCapabilities` array reference stability — voravitl

# v0.10.26 (2026-07-24)

## Fixes
- **LLM Translator (Request Normalization)**: flatten text-only content arrays (`[{ type: 'text', text: '...' }]`) to plain strings for OpenAI-compatible providers, eliminating 400 Bad Request payload structure errors — voravitl
- **LLM Stream Parser (NDJSON)**: support raw NDJSON stream lines starting with `{` in `parseSSELine` for Ollama/local model endpoints — voravitl
- **LLM Translator (Response Sanitization)**: safely initialize `toolCalls` state map and sanitize `Read` tool arguments in `openaiToClaudeResponse` — voravitl

# v0.10.25 (2026-07-23)

## Fixes
- **Antigravity (Model Sync)**: pass `{ project: projectId }` and `antigravity` User-Agent header in `fetchAvailableModels` requests, enabling full dynamic model listing in Sync Upstream Models UI — voravitl

# v0.10.24 (2026-07-23)

## Fixes
- **Antigravity (Model Sync)**: pass `{ project: projectId }` and `antigravity` User-Agent header in `fetchAvailableModels` requests, enabling full dynamic model listing in Sync Upstream Models UI — voravitl

# v0.10.23 (2026-07-23)

## Fixes
- **Antigravity (Token Refresh)**: restrict OAuth token refresh trigger to 401 Unauthorized only (preventing infinite token refresh loops on 403 Permission Denied) — voravitl

# v0.10.22 (2026-07-23)

## Fixes
- **Antigravity (Live Model Resolver)**: fix `refreshed?.access_token` typo (`accessToken`) in Google token refresh for `antigravity` live model resolver in `/v1/models` route — voravitl
- **Antigravity (MITM Defaults)**: restore `mandatory: true` flag on `gemini-3.5-flash-low` out-of-box default model slot in `cliTools.js` — voravitl

## UI / UX
- **Provider Detail (Sync Models)**: redesign `SyncProviderModelsModal` and `ModelsTable` with modern UI, quick filter tabs (`All`, `Available to add`, `Already added`), context window badges (`1M ctx`, `200k ctx`), and responsive selection counters — voravitl

## Fixes
- **Translator (Provider Variance)**: resolve provider variance across Ollama (`num_ctx` dynamic injection via `resolveKnownContextWindow` preventing 2,048-token context truncation and VRAM OOM), xAI/Grok (stateful `processStreamThinkingTags` parser preventing inline `<think>` tag leaks and routing reasoning to Claude `thinking_delta`), and Claude 4.6+ 1M context capabilities scoping (closes #154) — voravitl

# v0.10.19 (2026-07-20)

## Fixes
- **Translator (tool calling)**: response translators shipped a Claude `tool_use` block with an empty `name` when a provider streamed the tool name in a chunk *after* the one carrying the tool id (GLM 5.2, GPT, grok, kiro, codex). Anthropic-compatible clients then rejected it (`No such tool available: `), breaking the session — deepseek/claude were unaffected only because they send the name in the first chunk. Introduced shared `accumulateToolName()` (disambiguates split / re-echo / snapshot streaming shapes via prefix relationship), provisional tool slots keyed on index (name/args before id no longer dropped), and `stop_reason` downgrade `tool_use`→`end_turn` when every tool call is dropped. Applied to `openai-to-claude`, `kiro-to-claude`, `openai-responses` (closes #147; follow-up #149 for `responsesTransformer`) — voravitl
- **Headroom**: reject a `HEADROOM_URL` that resolves to a raw, non-loopback IP (e.g. an ephemeral Docker container IP like `10.100.0.2`) instead of a stable service name; falls back to configured/default and logs once (closes #129) — voravitl
- **Headroom + Kiro**: match compressed messages back to slots by `tool_call_id` instead of array index — Headroom may drop/reorder/merge messages, and positional mapping silently applied compressed text to the wrong slot, permanently corrupting kiro `conversationState`. Unknown/duplicate/missing ids are now skipped rather than guessed (#130) — voravitl

# v0.10.14 (2026-07-13)

## Features
- **Headroom + Kiro**: expand compress beyond toolResults — also large `userInputMessage` content (string/array text); multi-slot stable index mapping; error toolResults still preserved; fail-open (follow-up #122) — voravitl

# v0.10.13 (2026-07-13)

## Fixes
- **Headroom + Kiro**: send tool blobs as `role:tool` (not user) so Headroom actually compresses; verified live shrink 5914→569 chars — voravitl

# v0.10.12 (2026-07-13)

## Features
- **Headroom + Kiro**: compress large `conversationState` toolResult texts via Headroom `/v1/compress` (CodeWhisperer path); error traces preserved; fail-open (closes #122) — voravitl

# v0.10.11 (2026-07-13)

## Fixes
- **Token Savings**: Headroom section shows **LIVE reachable** vs historical log; explain why 24h period still lists this morning’s timeouts and when they drop off — voravitl

# v0.10.10 (2026-07-13)

## Fixes
- **Token Savings**: Headroom skip list split into **last 24h** vs full period so old Docker timeouts are not mistaken for live failures — voravitl

# v0.10.9 (2026-07-13)

## Fixes
- **Headroom**: Docker settings `localhost:8787` rewrites to `HEADROOM_URL` (e.g. `http://headroom:8787`); compress timeout 3s→15s; clearer kiro/timeout diagnostics — voravitl

# v0.10.8 (2026-07-13)

## Features
- **Token Savings charts**: big kept/saved bar, Before·After·Saved bars, daily saved area, top-filter bars (recharts) + daily `series` in summary API — voravitl

# v0.10.7 (2026-07-13)

## Features
- **Token Savings menu**: sidebar label + page shows aggregated before→after report (RTK bytes, Headroom tokens, period 24h/7d/30d, recent rows) via `/api/usage/token-save-summary` — voravitl

# v0.10.6 (2026-07-13)

## Fixes
- **Headroom**: status/setup flapping — probe `/livez`/`/healthz` (not slow upstream-aware `/readyz`/`/health`), longer timeout, cache CLI detect; toggle tracks enable setting not probe; compose healthcheck uses `/livez` — voravitl

# v0.10.5 (2026-07-13)

## Fixes
- **Test Chat**: `API key required for remote API access` when chatting via Docker — route Test Chat through `/api/dashboard/chat/completions` (dashboard session auth) instead of public `/v1` which requires an API key for non-loopback peers — voravitl

# v0.10.4 (2026-07-13)

## Fixes
- **Models / xAI**: `grok-4.5` context was 256k via generic `*grok-4*`; set **500k** (xAI docs) with `*grok-4.5*` / `*grok-4-5*` patterns; catalog lists `grok-4.5` — voravitl

# v0.10.3 (2026-07-13)

## Features
- **UI**: show **Test Chat** in the dashboard sidebar (was commented Hidden) so combo/model playground is discoverable after #110 — voravitl

# v0.10.2 (2026-07-13)

## Features
- **Dashboard**: basic-chat can select LLM combos and show token-save meta (RTK/headroom) after turns; Usage request-details shows Token save column + drawer (#106–#109) — voravitl
- **Observability**: persist `clientModel`, `rtkStats`, `headroomStats` on request details (flush path fixed so fields are not dropped) (#106–#109) — voravitl
- **CI/CD**: unit-smoke on PR; docker-publish gated on unit-smoke before image push — voravitl

## Fixes
- **xAI/Grok**: cap tools at 250 before upstream call to avoid `Maximum tools limit reached` 400 when Claude Code sends 260+ MCP tools (#111) — voravitl
- **basic-chat**: route chat through `/v1/chat/completions` (missing `/api/dashboard/chat/completions` was 404) — voravitl

# v0.7.2 (2026-07-05)

## Features

- **Usage**: `/api/usage/summary` now accepts a 9router Bearer API key (`Authorization: Bearer <key>`) in addition to the dashboard cookie auth, so external clients (the OMC HUD `rateLimitsProvider` script) can read aggregated limits without a browser session. Cookie auth is unchanged for the Web Dashboard (#40) — voravitl

# v0.7.1 (2026-07-04)

## Fixes

- **Usage**: `/api/usage/summary` returned 500 on every request because it imported a non-existent `PROVIDER_ID_TO_ALIAS` export (the file exports `ID_TO_ALIAS`). The bad import resolved to `undefined` and the alias lookup threw on the first connection. Fixed by importing `ID_TO_ALIAS` under the local alias (#38) — voravitl

# v0.7.0 (2026-07-04)

## Features

- **Usage**: new `GET /api/usage/summary` aggregates per-provider usage/limits across every active connection in one shot — claude (5h/7d), kiro (weekly), codebuddy, codex, github, google, and more. Mirrors the per-connection route's discipline: sequential OAuth refresh, parallel usage fetch, `{authExpired:true}` for re-auth prompts, `{skipped:true,reason}` for transient failures, `connectionId` to disambiguate multi-account. Foundation for OMC HUD multi-provider limit bars (client element in a follow-up) (#35, #36) — voravitl

# v0.6.3 (2026-07-04)

## Fixes

- **UI**: the dynamic `[1m]` copy suffix never fired on the providers detail page because page.js renders `ModelRow` from `./ModelRow.js` — a different component than the `ModelsCard` that #29/#31 wired. This PR wires `getContextWindow` + `fullModelWithSuffix` into the actual rendered row, so copying `glm/glm-5.2` now yields `glm/glm-5.2[1m]` (#33) — voravitl

# v0.6.2 (2026-07-04)

## Fixes

- **UI**: the dynamic `[1m]` copy hook (v0.6.1) silently 401'd in the browser because it fetched `/v1/models` (Bearer auth). Switched to `/api/models` (cookie auth) and added `contextWindow` to its caps response, so the suffix now resolves correctly when copying from the Web Dashboard (#31) — voravitl

# v0.6.1 (2026-07-04)

## Features

- **UI**: copy-to-clipboard on every model row in the Web Dashboard now appends `[1m]` when the model's resolved context window is ≥ 1M, so the copied value is Claude-Code-ready with zero user knowledge. Dynamic — resolved from the live `/v1/models` list (cached once per app, invalidated when models change), not a static catalog check. Server-side `[1m]` strip landed in v0.6.0; this is the UI companion (#28, #29) — voravitl

# v0.6.0 (2026-07-04)

## Features

- **Claude Code**: strip the `[1m]` suffix from model ids at the chat handler boundary so Claude Code can activate its 1M-context registry entry (`ANTHROPIC_DEFAULT_OPUS_MODEL=glm/glm-5.2[1m]`) without upstreams (z.ai) rejecting the suffixed id as `Unknown Model`. The suffix is a Claude-Code-internal signal; it does not leak to upstream (#25, #26) — voravitl

# v0.5.21 (2026-07-04)

## Fixes

- **Models**: GLM-5.2 exposed under dash/date-suffixed ids (e.g. `bpm/glm-5-2-260617` on BytePlus) resolved to 200k instead of its native 1M context, because the exact `glm-5.2` capability key only matches the dot form. Added `*glm-5.2*` / `*glm-5-2*` glob patterns (1M) before the `*glm-5*` 200k fallback so both forms resolve correctly (#22, #23) — voravitl

# v0.5.20 (2026-07-03)

## Fixes
- **Models**: combos (e.g. `rr-glm5.2`) returned by `/v1/models` did not expose `context_window`, so clients (Claude Code) could not see a combo's context. Now resolved dynamically as the **min** of member context windows — safe for every model the combo may route to (#17) — voravitl
- **Models**: web search/fetch combos no longer resolve a chat `context_window` (they have none), and combo context resolution no longer fabricates the 200k DEFAULT floor for genuinely-unknown members — a real 200k member is still honoured via provenance-based `resolveKnownContextWindow()` (#20) — voravitl

# v0.5.19 (2026-07-03)

## Fixes
- **Models**: `/v1/models` and `/v1/models/info` did not expose `context_window`, so clients (Claude Code) could not see the real context window and fell back to 200k. Resolve capabilities via `getCapabilitiesForModel()` in both routes and set `context_window`/`contextWindow` on the response. Also promote `glm-5.2` to global `MODEL_CAPABILITIES` so the 1M context wins regardless of provider alias (was hidden under `codebuddy-cn`) (#14) — voravitl

## Chores
- **Docker**: rename images, services, and volumes from `9router` to `888router` (publish target now `voravitl/888router`) (#14) — voravitl

# v0.5.18 (2026-07-02)

## Fixes
- **UI**: Sync Models modal gave no feedback when every upstream model was already added (empty-looking disabled checkboxes looked broken); add a visible added-state check, an "All upstream models are already added." banner, and an "N available to add" count (#12) — voravitl

# v0.5.17 (2026-07-02)

## Fixes
- **Providers**: xai (Grok) connection test returned "Provider test not supported"; add xai to `OAUTH_TEST_CONFIG` (probes `api.x.ai/v1/models` with Bearer, non-refreshable so expired/revoked tokens surface as 401) + regression test (#11) — voravitl

# v0.5.16 (2026-07-02)

## Features
- **Providers**: gate the Sync Models button to providers whose upstream can list LLM models (hide it for media/search/embedding/web-cookie providers) — voravitl

## Fixes
- **Kiro**: send the kiro-ide User-Agent on CodeWhisperer management calls so model sync works (was 403 "subscription does not support this application") — voravitl
- **Kiro**: fall back to the default profileArn when listing models — voravitl
- **Ollama**: resolve the Cloud API key from the `apiKey` field so model sync works — voravitl
- **Providers**: restore provider detail page features lost in a bad merge (bulk import, one-by-one test, auto-ping, multi-select, custom models, Qoder import) — voravitl

# v0.5.15 (2026-06-29)

## Features
- Add Kimchi OAuth provider — Nant361
- Refine Qwen vision/video + thinking model patterns — decolua
- Opt-in Codex auto-ping quota keep-alive — Emirhan

## Fixes
- **Responses**: handle response.done terminal events (#2142) — rifuki
- **Headroom**: skip unsafe responses tool history (#2132) — Sutarto Jordan Chrisfivo
- **Translator**: map mid-conversation system message to user (claude→openai) — decolua
- **Gemini**: normalize contents to prevent 400 invalid_argument (#2192) — warelik
- **Gemini**: backfill thoughtSignature + suppress stream done sentinel — WARELIK
- **Alicode**: preserve cache_control for DashScope providers (#2069) — Rex
- **Antigravity**: strip deprecated/readOnly/writeOnly from tool schemas — iletai, Yudhistira-Official
- **CodeBuddy CN**: show bonus packs as one-time, not monthly-replenishing — whale9820
- **Kiro**: strip leaked <thinking> tags from content stream (#2158) — hamsa0x7
- **Tray**: make Windows context menu DPI-aware — Emirhan
- **Kilocode**: expose full gateway catalog in combo model picker — jellylarper
- **OpenCode**: fix Go GLM — decolua

# v0.5.12 (2026-06-26)

## Features
- Add token-saver dashboard page — decolua
- Add bulk delete for provider connections — teddytkz
- Resolve GitHub Copilot model catalog from upstream — caiqinzhou
- Add Venice AI provider — Brokenc0de
- Add Kiro external_idp import for Microsoft SSO (CLIProxyAPI) — Stevanus Pangau
- Overhaul Blackbox provider catalog + WebUI test support — suryacagur

## Fixes
- Provider thinking compatibility (DeepSeek/Gemini) — Mink Nguyen
- Stop double-counting streaming usage at source — decolua
- Usage logging dedupe to reduce stats churn — Mink Nguyen
- Prevent non-JSON SSE lines / duplicate [DONE] from breaking clients (PR #2046) — qianze
- Resolve Gemini TTS models from catalog — nguyenha935
- Support Kiro IDC (organization) token import — quanturbo
- Preserve forced streaming for JSON clients (#2031) — Joseph Yaksich
- Preserve Responses text format (Codex) — tenglong
- Support Gemini native TTS generateContent endpoint — nguyenha935
- Add missing zh-CN endpoint key label (i18n) — weimaozhen
- CodeBuddy: only send reasoning params when client requests reasoning (#2071) — Rex
- CodeBuddy CN: show one-shot bonus packs as expiring, not monthly-replenishing
- Show custom provider models in combo picker — Sapto
- Docker: add docker-compose.yml with headroom enabled by default — nitsuahlabs
- Clarify token diagnostics vs provider billing (headroom, #1998) — Sutarto Jordan Chrisfivo
- Translate openai-responses input through OpenAI for compression (#1998) — Ankit
- Kiro: report 1M context window for claude-opus-4.8 — EdisonPVE
- Avoid stale redirects after auth changes (#2100) — Emirhan
- Mark Claude Opus 4.7 (dashed id) as 1M context — Brokenc0de
- Preserve reasoning effort through Codex translations — ntdung6868
- Token-saver: full width card layout — decolua
- Antigravity: retry transient upstream failures — Sutarto Jordan Chrisfivo
- Param-support: handle strip rules without match/drop (#1960) — Joseph Yaksich
- Translator: resolve custom provider prefix in debug endpoint (#1083) — hamsa0x7

# v0.5.8 (2026-06-21)

## Features
- **Antigravity**: native image generation support (image models tagged kind:image, hiển thị trong media-providers UI)
- **CodeBuddy CN**: API key auth + credit quota tracker
- **CodeBuddy CN**: short model prefix alias "cbcn"

## Fixes
- **MiniMax-M3**: enable vision capability
- **Headroom**: support Docker sidecar proxy
- **Antigravity**: image executor fixes
- **mimo-free**: Chrome User-Agent rotation to bypass anti-abuse gate
- **cloudflare-ai**: flatten content-part arrays to string to avoid oneOf 400 (#1926)
- **Translator**: normalize tools to Anthropic-native shape for non-Anthropic providers
- **CLI**: handle Next.js 16 nested standalone output path (#1940)
- **Codex**: preserve custom tools during request normalization
- **next.config**: add new route for responses endpoint to API

# v0.5.6 (2026-06-20)

## Features
- **Ponytail**: minimalist code generation feature
- **Headroom**: proxy lifecycle management + dashboard UI (one-click start/stop, install detection, status probing, token saver, claude↔openai shape conversion)
- **CodeBuddy CN**: new OAuth provider (copilot.tencent.com) — 15-model catalog, /v2 inference, forced streaming, OpenAI-style reasoning
- **OpenCode-Go**: align models with official endpoints; route Qwen 3.7 MiniMax via /v1/messages, GLM/Kimi/DeepSeek/MiMo via /chat/completions

## Fixes
- **Anthropic-compatible validation**: use POST /v1/messages (GET /models not spec, false "invalid" for valid keys)
- **CLI tools**: tolerate JSONC configs in all 8 settings routes (opencode, openclaw, kilo, droid, cowork, copilot, claude, cline)
- **Gemini/Antigravity**: preserve 'pattern' in tool schema translation (glob/grep)
- **Combo/Fusion**: flatten Anthropic-style tool messages in panel calls (prevent 503)
- **Models**: store provider custom models by provider scope
- **Perplexity**: use /v1/models endpoint for key validation

# v0.5.4 (2026-06-18)

## Fixes
- **Kiro**: honor thinking effort budgets
- **AG/Kiro/Xiaomi**: provider fixes
- **Combo/Fusion**: flatten tool history in panel calls to prevent 503
- **LLM selector**: show custom vision models in selector and model list
- **Image**: prevent compatible nodes from shadowing provider aliases

# v0.5.2 (2026-06-17)

## Features
- **Combo Fusion strategy** — fans the prompt out to all member models in parallel, then a configurable judge model synthesizes one final answer (quorum-grace, anonymized sources, graceful degradation)
- **Per-combo strategy selector** — pick `fallback` / `round-robin` / `fusion` / `capacity` per combo (replaces the old round-robin toggle), with a judge picker for fusion
- **Capacity auto-switch** — reorders models per request so images/PDFs route to capable models first
- **Kiro headless API-key auth** (`ksk_`) + direct `claude↔kiro` route that avoids the lossy OpenAI two-hop pivot
- **Claude auto-ping** — warms the 5h quota window right after reset so a fresh window starts immediately (per-connection toggle)

## Fixes
- **Claude 429**: stop hammering the OAuth usage endpoint — cache resetAt, throttle quota refresh to 3 min, cool down after a 429 (chat unaffected)
- **Usage logs always empty**: missing `await` on `getAdapter()` in `getRecentLogs` made `/api/usage/logs` & `/api/usage/request-logs` return nothing
- **Executors**: strip params unsupported by the provider/model (drops deprecated `temperature` for claude-opus-4 → Anthropic 400)
- **Translator**: derive deterministic tool_call ids for gemini/antigravity → OpenAI so function call/response pair correctly (fixes tool-pairing 400s)
- **Antigravity**: strip `optional` from tool schemas before sending to Gemini
- **Claude-to-OpenAI**: handle OpenAI-format responses in the non-streaming path (e.g. xiaomi-tokenplan)
- **Usage views**: show edited connection names consistently across Providers & Quota Tracker
- **Security**: hardened reverse-proxy local-access trust
- **Security**: SSRF hardening on web fetch

## Internal
- Large **open-sse / translator refactor** (~40 commits): unified provider/model registry (LiteLLM-style `models[]` + `kind` field, 100 co-located registry files), single-sourced media/OAuth/refresh/token URLs, registry-based dispatch for usage & token-refresh, DRY translator concerns (buildUsage, encodeDataUri, finishReasonMap, chunkBuilder, reasoningDelta…), ESM-safe registry init, large-file splits, dead-code removal, and golden/no-regression test gates

# v0.4.80 (2026-06-13)

## Features
- Vercel AI Gateway: support embeddings, images and credit usage (#1183)
- Add MiMo Free no-auth provider (#1789)
- Vertex: support ADC `authorized_user` credential
- Cowork: re-enable Claude Cowork with preset-only stdio MCP
- Codex: bulk add accounts via JSON (#1719)
- Kiro: enable multi-endpoint failover for GenerateAssistantResponse (#1722)

## Fixes
- Security: re-auth on DB export/import + SSRF guard on web fetch
- Auth: real client IP rate-limiting + remote default-password guard
- Cerebras/Mistral: strip unsupported `client_metadata` from downstream requests (#1742)
- SiliconFlow: update baseUrl `.cn` -> `.com` + curate verified model list (#1760)
- Gemini-to-OpenAI: route unsigned thought parts to `reasoning_content` (#1752)
- Claude-to-OpenAI: strip Anthropic billing header from system prompt (#1765)
- Anthropic-compatible: send Bearer auth for third-party gateways (#1795)
- Usage-stats: avoid partial stats on initial SSE race (#1767)
- Proxy: use `export default` in proxy.js for Next.js 16 middleware detection
- Claude passthrough: add body normalization
- GitHub Copilot: refresh missing/expired token on models discovery (#1727) + add mappable gpt-5-mini/gpt-5.4-nano slots for Copilot MITM (#1653)
- Kiro: auto-resolve profileArn to prevent 403 on IDC login, enhance profile ARN resolution, update endpoint to `runtime.us-east-1.kiro.dev` (#1713)
- Tunnel: detect system-installed Tailscale via dual-socket probe (#1723) + non-blocking probes to prevent UI freeze
- CommandCode: force `stream=true` in transformRequest (#1706)
- Qoder: increase timeouts for reasoning models and improve stream handling
- Dashboard: show provider node name instead of connection name in topology (#1770) + show explicit `kind="llm"` combos on combos page (#1684)

## Docs
- README: add Indonesian 9Router tutorial video (#1709)

# v0.4.71 (2026-06-06)

## Features
- Caveman: add wenyan classical Chinese levels and sync upstream prompts; locale-based visibility on endpoint page
- i18n: endpoint exposure notice across multiple languages + Russian README
- Antigravity: add gemini-3.5-flash-extra-low (Low) model
- xiaomi-tokenplan: add Claude-native MiMo V2.5 Pro alias via dedicated executor
- Qoder: fetch latest model + dashboard import-model button (#1642)
- MiniMax: add MiniMax-M3 + update Quota Tracker coding/CN (#1631)

## Fixes
- Codex: harden streaming timeouts (stall/connect raised to 60s, configurable per-provider), accept `response.done` event, and always emit a terminal `response.failed` + `[DONE]` for Responses passthrough when a stream closes, stalls, or aborts before a terminal event — prevents codex clients from hanging (#1648, #1680, #1688, #1618)
- Codex: durable OAuth refresh lifecycle (#1664)
- Tunnel: skip virtual interfaces to prevent false netchange watchdog
- Claude: fix forced tool_choice 400 on cc/ OAuth route (#1592)
- Proxy: raise Next client body limit to 128MB via `NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE` (#1529, #1572)
- MiniMax: echo `reasoning_content` on follow-up turns to avoid 400 (#1543)
- Kiro: handle 400 on tool-bearing history without client tools; add mappable "auto" model slot; fix binary EventStream crash + add models & TTS tool filtering
- Antigravity: passthrough tab-autocomplete + mark default agent slot mandatory
- Qoder: allow `qmodel_latest` model key (#1638)
- Providers: restore one-connection guard for compatible/embedding nodes
- Model-test: route image/STT probes to their real endpoints, harden STT ping; add opencode-go + xiaomi-tokenplan to connection test (#1576, #1628)

## Improvements
- Dashboard: reorganize menu actions across sidebar/header/profile
- Translator: add data-driven coverage, bug-exposing cases, and real provider smoke tests

# v0.4.66 (2026-05-29)

## Features
- Add Qoder provider: device-flow OAuth, COSY signing, WAF-bypass body encoding, live model catalog, dashboard quota tracker, 11 models (#1372)
- Add new models: Claude Opus 4.8 (Claude Code), GPT 5.4 Mini (Codex)

## Fixes
- DeepSeek thinking mode: echo `reasoning_content` back on follow-up/tool-call turns so OpenCode-free and custom providers no longer 400 with "reasoning_content must be passed back" (#1543)
- Reasoning injector: match deepseek/kimi model ids case-insensitively (covers custom providers using capitalized model names)
- OpenCode suggested-models: include free models without the `-free` suffix, e.g. `big-pickle` (#1535)

## Improvements
- Codex: trim sunset models, keep gpt-5.5 / gpt-5.4 / gpt-5.3-codex family, add gpt-5.4-mini
- volcengine-ark: refresh model list (add DeepSeek-V4-Flash/Pro, drop EOL entries)
- Lower stream stall timeout 35s → 30s for faster hang detection

# v0.4.63 (2026-05-26)

## Fixes
- GitHub Copilot: never route Gemini/Claude models to the `/responses` endpoint; prevents misleading "does not support Responses API" 400s (#1062)
- proxyFetch: restore missing `Readable` import causing runtime `ReferenceError` in DNS-bypass fetch path

## Improvements
- Lower stream stall timeout from 60s → 35s for faster hang detection

# v0.4.62 (2026-05-26)

## Fixes
- Codex: auto-retry when upstream drops mid-stream (no more hangs)
- Codex: fix random 400/404 errors, tool-calling failures, and unstable prompt cache
- MITM: support Antigravity 2.x 
- Sanitize Read tool args to prevent retry loops from non-Anthropic models (#1144)
- Implement json_schema fallback for OpenAI-compatible providers without native Structured Output (#1343)
- Strip empty Read pages argument in OpenAI-to-Claude translator (#1354)
- Forward Gemini output dimensions for embeddings (#1366)
- Resolve setState-in-effect errors in dashboard components (#1362)
- Gemini CLI: reuse stored OAuth project IDs for quota checks and show clearer setup guidance when the project is missing (#1271, #1428)

## Features
- Add Cloudflare Workers proxy deployer and pool integration (#1360)
- Add Deno Deploy relays support and improved proxy pools dashboard layout (#1437)

## Improvements
- Refactor Tunnel into dedicated Cloudflare and Tailscale manager modules
- Refactor tokenRefresh service with in-flight dedup to prevent refresh_token_reused errors

# v0.4.59 (2026-05-21)

## Fixes
- OAuth: fix login flow on Windows

# v0.4.58 (2026-05-21)

## Features
- xAI Grok provider (OAuth, API key, image)
- Provider limits: paginated accounts with page size controls

## Fixes
- Tailscale: fix connection status on Windows (#1300)
- Tunnel: fix false "checking" when tunnel URL is reachable
- Stream: fix pipe errors on client disconnect/abort

# v0.4.55 (2026-05-18)

## Features
- Xiaomi MiMo Token Plan: region selector (Singapore / China / Europe) — keys are cluster-specific
- Antigravity: risk confirmation dialog before first connection
- Gemini CLI: surface upstream retry delay on 429 errors

## Fixes
- MITM: cannot kill process on macOS under sudo (lsof not found in PATH)
- Stream: false-positive stall timeout on Claude reasoning / Kiro responses
- Tunnel: cannot re-enable after disable (stuck state)
- Tunnel: cloudflared error messages now include log tail for easier debugging
- Language switcher: applies selected locale immediately on close (#1234)
- Antigravity OAuth: metadata now matches the official client

## Improvements
- Gemini CLI: bump engine to 0.34.0
- Re-hide `qwen` (OAuth EOL) and `iflow` (not ready) providers

# v0.4.52 (2026-05-17)

## Features
- Add Vercel AI Gateway provider support (#1183)
- rtk: Kiro format tool result compression — handle conversationState.history & currentMessage, preserve error results, ~13.6% savings (#1194)

## Fixes
- openclaw: normalize agent.model object form `{primary, fallbacks}` before .startsWith → fix TypeError & 'not configured' status (#1216)
- Usage Details pagination: stay inside mobile viewport <640px (#1218)
- Fix test model error
- Fix MIMO provider in Codex
- Disable log file creation when using MITM AG

# v0.4.50 (2026-05-16)

## Fixes
- Fix duplicate tray icon on macOS when hiding to tray
- Fix tray not showing in background mode on macOS
- Fix hide to tray broken on Windows/Linux
- Fix Shutdown button in web UI not working

# v0.4.49 (2026-05-16)

## Features
- Add Kiro provider support: full request/response translation, live model listing, reasoning content support
- Add `buildOutput` RTK filter with autodetect for npm/yarn/cargo build logs
- Add MITM warning notification in tray and dashboard

## Improvements
- Add modalities (input/output) to model configuration for OpenCode
- Fix tray hide-to-tray: keep current process alive instead of spawning detached child (fixes macOS NSStatusItem ghost icon)
- Fix tray kill: graceful shutdown with SIGTERM/SIGKILL escalation
- Fix SIGHUP handling so macOS terminal close doesn't kill tray process
- Hide deprecated providers (qwen, iflow, antigravity)
- Update i18n across 32 languages

## Fixes
- Fix model check (test-models) blocked by dashboardGuard: pass machineId-based CLI token in internal self-calls

# v0.4.46 (2026-05-15)

## Breaking Changes
- Tunnel public URL changed — old tunnel links no longer work, please reconnect to get the new URL