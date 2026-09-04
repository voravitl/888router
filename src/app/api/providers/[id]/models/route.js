import { NextResponse } from "next/server";
import { parseCloudflareModelsResponse } from "@/lib/cloudflareAiModels";
import { getProviderConnectionById } from "@/models";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider, isPublicModelsProvider } from "@/shared/constants/providers.js";
import { KiroService } from "@/lib/oauth/services/kiro";
import { OllamaService } from "@/lib/oauth/services/ollama";
import { GEMINI_CONFIG, ANTIGRAVITY_CONFIG } from "@/lib/oauth/constants/oauth";
import { refreshGoogleToken, updateProviderCredentials, refreshKiroToken } from "@/sse/services/tokenRefresh";
import { resolveOllamaLocalHost, PROVIDERS } from "open-sse/config/providers.js";
import { refreshProviderCredentials } from "open-sse/services/oauthCredentialManager.js";
import { resolveQoderModels } from "open-sse/services/qoderModels.js";
import { formatModelsFetchError, safeLogDetail } from "@/lib/upstreamErrorDetail";

const GEMINI_CLI_MODELS_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";

const parseOpenAIStyleModels = (data) => {
  if (Array.isArray(data)) return data;
  return data?.data || data?.models || data?.results || [];
};

const expandGeminiTieredModel = (id, displayName) => {
  const match = typeof id === "string" ? id.match(/^(gemini-[\d.]+-flash)-tiered$/) : null;
  if (match) {
    const prefix = match[1];
    const ver = prefix.replace("gemini-", "").replace("-flash", "");
    return [
      { id, name: displayName || id },
      { id: `${prefix}-high`, name: `Gemini ${ver} Flash (High)` },
      { id: `${prefix}-medium`, name: `Gemini ${ver} Flash (Medium)` },
      { id: `${prefix}-low`, name: `Gemini ${ver} Flash (Low)` },
    ];
  }
  return [{ id, name: displayName || id }];
};

const parseGeminiCliModels = (data) => {
  if (Array.isArray(data?.models)) {
    return data.models
      .flatMap((item) => {
        const id = item?.id || item?.model || item?.name;
        if (!id) return [];
        return expandGeminiTieredModel(id, item?.displayName || item?.name || id);
      })
      .filter(Boolean);
  }

  if (data?.models && typeof data.models === "object") {
    return Object.entries(data.models)
      .filter(([, info]) => !info?.isInternal)
      .flatMap(([id, info]) => {
        return expandGeminiTieredModel(id, info?.displayName || info?.name || id);
      });
  }

  return [];
};

const appendCodexReviewModels = (models) => models.flatMap((model) => {
  const id = model?.id || model?.slug || model?.model || model?.name;
  if (!id) return [];
  const name = model?.display_name || model?.displayName || model?.name || id;
  const contextLength = Number(model?.max_context_window || model?.context_window || model?.context_length || model?.contextWindow) || undefined;
  const vision = Array.isArray(model?.input_modalities)
    ? model.input_modalities.includes("image")
    : (model?.vision ?? model?.supportsImages ?? model?.supportsVision);
  const normalized = {
    ...model,
    id,
    name,
    ...(contextLength ? { context_length: contextLength, contextWindow: contextLength } : {}),
    ...(vision !== undefined ? { vision: Boolean(vision) } : {}),
  };
  const isChatModel = (model?.type || "llm") !== "image" && !id.toLowerCase().includes("embed");
  if (!isChatModel || id.endsWith("-review")) return [normalized];
  return [
    normalized,
    {
      ...normalized,
      id: `${id}-review`,
      name: `${name} Review`,
      upstreamModelId: id,
      quotaFamily: "review",
    },
  ];
});

const parseCodexModels = (data) => appendCodexReviewModels(parseOpenAIStyleModels(data));

// Enrich models with lastSyncedAt / firstSeenAt from the syncedModels kv.
// Only stamps when models.length > 0 (empty list is a static-fallback signal).
export async function buildModelsResponse({ provider, connectionId, models, warning }) {
  const rawModels = Array.isArray(models) ? models.filter((m) => m && m.id) : [];
  // Dedup by model ID (upstream may return duplicates)
  const seen = new Set();
  const safeModels = [];
  for (const m of rawModels) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    safeModels.push(m);
  }
  let stampMap = {};
  if (safeModels.length > 0) {
    try {
      const db = await import("@/lib/db");
      if (typeof db.stampSyncedModels === "function") {
        await db.stampSyncedModels(safeModels.map((m) => ({ connectionId, modelId: m.id })));
      }
      if (typeof db.getSyncedModelsMap === "function") {
        stampMap = (await db.getSyncedModelsMap()) || {};
      }

      // Extract & persist dynamic capabilities metadata from upstream response
      try {
        const { saveModelDynamicCapabilities } = await import("@/lib/db");

        for (const m of safeModels) {
          const id = m.id;
          const ctx = m.max_context_window || m.context_length || m.contextWindow || m.context_window || m.maxInputTokens || m.contextLength || m.details?.context_length;
          const vision = m.vision ?? m.supportsImages ?? m.supportsVision ?? m.details?.families?.includes("vision")
            ?? (Array.isArray(m.input_modalities) ? m.input_modalities.includes("image") : undefined);
          
          let resolvedReasoning = undefined;
          if (typeof m.reasoning === "boolean") {
            resolvedReasoning = m.reasoning;
          } else if (Array.isArray(m.thinking) && m.thinking.length > 0) {
            resolvedReasoning = true;
          } else if (typeof m.thinking === "boolean") {
            resolvedReasoning = m.thinking;
          }

          const ctxNum = Number(ctx);
          const hasValidCtx = Number.isFinite(ctxNum) && ctxNum > 0;

          if (hasValidCtx || vision !== undefined || resolvedReasoning !== undefined) {
            const caps = {};
            if (hasValidCtx) caps.contextWindow = ctxNum;
            if (vision !== undefined) caps.vision = Boolean(vision);
            if (resolvedReasoning !== undefined) caps.reasoning = resolvedReasoning;

            if (typeof saveModelDynamicCapabilities === "function") {
              await saveModelDynamicCapabilities(provider, id, caps);
            }
            // Persist provider-scoped only. The bare-modelId in-memory register
            // bled caps across providers sharing an id (PR #292 lesson); readers
            // (/v1/models, resolveCapabilities) load the scoped rows instead.
          }
        }
      } catch (capErr) {
        console.log("Failed to save dynamic capabilities:", capErr?.message);
      }
    } catch (error) {
      console.log("Failed to stamp synced models:", error?.message);
      stampMap = {};
    }
  }
  const enrichedModels = safeModels.map((m) => {
    const entry = stampMap[`${connectionId}:${m.id}`];
    return {
      ...m,
      lastSyncedAt: entry?.lastSyncedAt ?? null,
      firstSeenAt: entry?.firstSeenAt ?? null,
    };
  });
  const payload = {
    provider,
    connectionId,
    models: enrichedModels,
  };
  if (warning !== undefined) payload.warning = warning;
  return NextResponse.json(payload);
}

const createOpenAIModelsConfig = (url) => ({
  url,
  method: "GET",
  headers: { "Content-Type": "application/json" },
  authHeader: "Authorization",
  authPrefix: "Bearer ",
  parseResponse: parseOpenAIStyleModels
});

const resolveQwenModelsUrl = (connection) => {
  const fallback = "https://portal.qwen.ai/v1/models";
  const raw = connection?.providerSpecificData?.resourceUrl;
  if (!raw || typeof raw !== "string") return fallback;
  const value = raw.trim();
  if (!value) return fallback;
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return `${value.replace(/\/$/, "")}/models`;
  }
  return `https://${value.replace(/\/$/, "")}/v1/models`;
};

// Provider models endpoints configuration
const PROVIDER_MODELS_CONFIG = {
  claude: {
    url: "https://api.anthropic.com/v1/models",
    method: "GET",
    headers: {
      "Anthropic-Version": "2023-06-01",
      "Anthropic-Beta": "oauth-2025-04-20",
      "Content-Type": "application/json"
    },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => data.data || []
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authQuery: "key", // Use query param for API key
    parseResponse: (data) => data.models || []
  },
  qwen: {
    url: "https://portal.qwen.ai/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => data.data || []
  },
  codex: {
    url: "https://chatgpt.com/backend-api/codex/models?client_version=0.144.6",
    method: "GET",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "originator": "codex_cli_rs" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: parseCodexModels
  },
  antigravity: {
    // Google CloudCode has no `:models` endpoint (404). The real endpoint is
    // `:fetchAvailableModels` — same as gemini-cli (GEMINI_CLI_MODELS_URL) — with
    // the shared parseGeminiCliModels parser. antigravity is deprecated with a
    // static registry fallback, so a failed dynamic fetch degrades quietly.
    url: GEMINI_CLI_MODELS_URL,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    body: {},
    parseResponse: parseGeminiCliModels
  },
  github: {
    url: "https://api.githubcopilot.com/models",
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Copilot-Integration-Id": "vscode-chat",
      "editor-version": "vscode/1.107.1",
      "editor-plugin-version": "copilot-chat/0.26.7",
      "user-agent": "GitHubCopilotChat/0.26.7"
    },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => {
      if (!data?.data) return [];
      // Filter out embeddings, non-chat models, and disabled models
      return data.data
        .filter(m => m.capabilities?.type === "chat")
        .filter(m => m.policy?.state !== "disabled") // Only return explicitly enabled models
        .map(m => ({
          id: m.id,
          name: m.name || m.id,
          version: m.version,
          capabilities: m.capabilities,
          isDefault: m.model_picker_enabled === true
        }));
    }
  },
  openai: createOpenAIModelsConfig("https://api.openai.com/v1/models"),
  openrouter: createOpenAIModelsConfig("https://openrouter.ai/api/v1/models"),
  anthropic: {
    url: "https://api.anthropic.com/v1/models",
    method: "GET",
    headers: {
      "Anthropic-Version": "2023-06-01",
      "Content-Type": "application/json"
    },
    authHeader: "x-api-key",
    parseResponse: (data) => data.data || []
  },
  agentrouter: {
    url: "https://agentrouter.org/v1/models",
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Claude-Code/0.2.29",
      "anthropic-version": "2023-06-01",
    },
    authHeader: "x-api-key",
    parseResponse: (data) => (Array.isArray(data) ? data : data?.data || data?.models || []),
  },

  alicode: {
    url: "https://coding.dashscope.aliyuncs.com/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => data.data || []
  },
  "alicode-intl": {
    url: "https://coding-intl.dashscope.aliyuncs.com/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => data.data || []
  },
  "volcengine-ark": createOpenAIModelsConfig("https://ark.cn-beijing.volces.com/api/coding/v3/models"),
  byteplus: createOpenAIModelsConfig("https://ark.ap-southeast.bytepluses.com/api/coding/v3/models"),

  // OpenAI-compatible API key providers
  deepseek: createOpenAIModelsConfig("https://api.deepseek.com/models"),
  groq: createOpenAIModelsConfig("https://api.groq.com/openai/v1/models"),
  xai: createOpenAIModelsConfig("https://api.x.ai/v1/models"),
  mistral: createOpenAIModelsConfig("https://api.mistral.ai/v1/models"),
  perplexity: createOpenAIModelsConfig("https://api.perplexity.ai/models"),
  together: createOpenAIModelsConfig("https://api.together.xyz/v1/models"),
  fireworks: createOpenAIModelsConfig("https://api.fireworks.ai/inference/v1/models"),
  cerebras: createOpenAIModelsConfig("https://api.cerebras.ai/v1/models"),
  cohere: createOpenAIModelsConfig("https://api.cohere.ai/v1/models"),
  nebius: createOpenAIModelsConfig("https://api.studio.nebius.ai/v1/models"),
  siliconflow: createOpenAIModelsConfig("https://api.siliconflow.cn/v1/models"),
  hyperbolic: createOpenAIModelsConfig("https://api.hyperbolic.xyz/v1/models"),
  ollama: createOpenAIModelsConfig("https://ollama.com/api/tags"),
  // ollama-local: url resolved dynamically below via providerSpecificData.baseUrl
  nanobanana: createOpenAIModelsConfig("https://api.nanobananaapi.ai/v1/models"),
  chutes: createOpenAIModelsConfig("https://llm.chutes.ai/v1/models"),
  nvidia: createOpenAIModelsConfig("https://integrate.api.nvidia.com/v1/models"),
  assemblyai: createOpenAIModelsConfig("https://api.assemblyai.com/v1/models"),

  // API-key providers with OpenAI-style GET /models endpoints
  blackbox: createOpenAIModelsConfig("https://api.blackbox.ai/v1/models"),
  kimi: createOpenAIModelsConfig("https://api.kimi.com/coding/v1/models"),
  minimax: createOpenAIModelsConfig("https://api.minimax.io/v1/models"),
  "minimax-cn": createOpenAIModelsConfig("https://api.minimaxi.com/v1/models"),
  opencode: createOpenAIModelsConfig("https://opencode.ai/zen/v1/models"),
  "opencode-zen": createOpenAIModelsConfig("https://opencode.ai/zen/v1/models"),
  "opencode-go": createOpenAIModelsConfig("https://opencode.ai/zen/go/v1/models"),
  venice: createOpenAIModelsConfig("https://api.venice.ai/api/v1/models"),
  "vercel-ai-gateway": createOpenAIModelsConfig("https://ai-gateway.vercel.sh/v1/models"),
  tokenrouter: createOpenAIModelsConfig("https://api.tokenrouter.com/v1/models"),
  "xiaomi-mimo": createOpenAIModelsConfig("https://api.xiaomimimo.com/v1/models"),
  // GLM coding API: non-standard /v4 path, verified live to return the OpenAI {object,data} shape
  glm: createOpenAIModelsConfig("https://api.z.ai/api/coding/paas/v4/models"),
  nousresearch: createOpenAIModelsConfig("https://inference-api.nousresearch.com/v1/models"),
  "nous-portal": createOpenAIModelsConfig("https://inference-api.nousresearch.com/v1/models"),
  bai: createOpenAIModelsConfig("https://api.b.ai/v1/models"),
  "b-ai": createOpenAIModelsConfig("https://api.b.ai/v1/models"),
  gmi: createOpenAIModelsConfig("https://api.gmi-serving.com/v1/models"),
  "gmi-cloud": createOpenAIModelsConfig("https://api.gmi-serving.com/v1/models"),
  gmicloud: createOpenAIModelsConfig("https://api.gmi-serving.com/v1/models"),

  // Cloudflare Workers AI: account-scoped endpoint, requires accountId in path.
  // URL resolved per-request in buildFetchRequest (below) from providerSpecificData.accountId.
  // Response shape: { result: [{ id, name, description, source, task: { ... } }] }.
  "cloudflare-ai": {
    url: "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/models/search",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: parseCloudflareModelsResponse,
  },
};

/**
 * GET /api/providers/[id]/models - Get models list from provider
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    let connection = await getProviderConnectionById(id);

    if (!connection) {
      if (id === "aipass-virtual") {
        connection = { id: "aipass-virtual", provider: "aipass", isActive: true };
      }
    }

    if (!connection) {
      try {
        const { getProviderConnections } = await import("@/models");
        const matching = await getProviderConnections({ provider: id, isActive: true });
        if (matching?.length > 0) {
          connection = matching[0];
        }
      } catch {}
    }

    if (!connection) {
      if (isPublicModelsProvider(id)) {
        connection = { id: `public:${id}`, provider: id, isActive: true };
      } else {
        return NextResponse.json({ error: "Connection not found" }, { status: 404 });
      }
    }

    if (isOpenAICompatibleProvider(connection.provider)) {
      const baseUrl = connection.providerSpecificData?.baseUrl;
      if (!baseUrl) {
        return NextResponse.json({ error: "No base URL configured for OpenAI compatible provider" }, { status: 400 });
      }
      const url = `${baseUrl.replace(/\/$/, "")}/models`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${connection.apiKey}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.log(`Error fetching models from ${connection.provider}:`, safeLogDetail(response.status, errorText));
        return NextResponse.json(
          { error: formatModelsFetchError(response.status, errorText) },
          { status: response.status }
        );
      }

      const data = await response.json();
      const models = data.data || data.models || [];

      return buildModelsResponse({
        provider: connection.provider,
        connectionId: connection.id,
        models
      });
    }

    if (isAnthropicCompatibleProvider(connection.provider)) {
      let baseUrl = connection.providerSpecificData?.baseUrl;
      if (!baseUrl) {
        return NextResponse.json({ error: "No base URL configured for Anthropic compatible provider" }, { status: 400 });
      }

      baseUrl = baseUrl.replace(/\/$/, "");
      if (baseUrl.endsWith("/messages")) {
        baseUrl = baseUrl.slice(0, -9);
      }

      const url = `${baseUrl}/models`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": connection.apiKey,
          "anthropic-version": "2023-06-01",
          "Authorization": `Bearer ${connection.apiKey}`
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.log(`Error fetching models from ${connection.provider}:`, safeLogDetail(response.status, errorText));
        return NextResponse.json(
          { error: formatModelsFetchError(response.status, errorText) },
          { status: response.status }
        );
      }

      const data = await response.json();
      const models = data.data || data.models || [];

      return buildModelsResponse({
        provider: connection.provider,
        connectionId: connection.id,
        models
      });
    }

    // Kiro: Try dynamic model fetching first
    if (connection.provider === "kiro") {
      let warning;
      try {
        const kiroService = new KiroService();
        const storedProfileArn = connection.providerSpecificData?.profileArn;
        // Only send a profileArn we actually have on the connection. ListAvailableModels
        // strictly enforces profileArn ownership: the hardcoded shared default ARN
        // (resolveDefaultProfileArn) returns AccessDeniedException (403) for Builder-ID/
        // social tokens whose bound profile differs (verified live), while omitting
        // profileArn makes AWS fall back to the token's own bound profile (200 OK).
        // NOTE: diverges from the chat translators (claude/openai-to-kiro.js) and usage
        // lookup (usage/kiro.js) which still inject the shared default — GenerateAssistant
        // Response tolerates it today, ListAvailableModels does not; those need separate
        // live verification.
        const profileArn = storedProfileArn || "";
        const accessToken = connection.accessToken;
        const refreshToken = connection.refreshToken;

        if (accessToken) {
          try {
            const models = await kiroService.listAvailableModels(accessToken, profileArn);
            return buildModelsResponse({
              provider: connection.provider,
              connectionId: connection.id,
              models
            });
          } catch (error) {
            if (error.message.includes("AccessDeniedException") && refreshToken) {
              console.log("Kiro token invalid/expired. Attempting refresh...");
              const refreshed = await refreshKiroToken(refreshToken, connection.providerSpecificData);

              if (refreshed?.accessToken) {
                await updateProviderCredentials(connection.id, {
                  accessToken: refreshed.accessToken,
                  refreshToken: refreshed.refreshToken || refreshToken,
                  expiresIn: refreshed.expiresIn,
                });

                const refreshedProfileArn = refreshed.profileArn || profileArn;
                const models = await kiroService.listAvailableModels(refreshed.accessToken, refreshedProfileArn);
                return buildModelsResponse({
                  provider: connection.provider,
                  connectionId: connection.id,
                  models
                });
              }
            }
            throw error; // Let outer catch handle it
          }
        }
      } catch (error) {
        // Dynamic listing failed — surface the actual error and let the client keep using
        // the built-in static catalog. (The common historical cause, a 403 "subscription
        // does not support this application", was a missing kiro-ide User-Agent header,
        // now fixed in listAvailableModels — so this path is a genuine-failure fallback.)
        const message = error?.message || "";
        warning = `Failed to fetch Kiro models: ${message}`;
        console.log("Failed to fetch Kiro models dynamically, falling back to static:", message);
      }

      // Return an empty dynamic list so the client keeps using the built-in static
      // catalog. Do NOT inject the static catalog here: this endpoint is shared with
      // basic-chat, which would then show every Kiro model twice (static prefixed id
      // + unprefixed live id that dedupe cannot collapse).
      return buildModelsResponse({
        provider: connection.provider,
        connectionId: connection.id,
        models: [],
        warning,
      });
    }

    // Qoder: fetch the live COSY-signed catalog — the same source chat uses
    // for per-model model_config (open-sse/services/qoderModels.js).
    if (connection.provider === "qoder") {
      let warning;
      try {
        const catalog = await resolveQoderModels(connection, { forceRefresh: true });
        if (catalog) {
          if (catalog.models.length === 0) {
            // Valid token but upstream published every model as enable:false —
            // seen live on 0-credit / quota-exceeded accounts. Surface it
            // instead of silently returning an empty table.
            warning = "Qoder catalog fetched, but every model is disabled for this account (check plan/credits on qoder.com).";
          }
          return buildModelsResponse({
            provider: connection.provider,
            connectionId: connection.id,
            models: catalog.models,
            warning,
          });
        }
        warning = "Failed to fetch Qoder models: no catalog returned (missing/expired credentials or upstream error)";
      } catch (error) {
        warning = `Failed to fetch Qoder models: ${error?.message || ""}`;
        console.log("Failed to fetch Qoder models dynamically, falling back to static:", error?.message);
      }

      // Return an empty dynamic list so the client keeps using the built-in
      // static catalog (same graceful-fallback shape as the Kiro branch above).
      return buildModelsResponse({
        provider: connection.provider,
        connectionId: connection.id,
        models: [],
        warning,
      });
    }

    // AgentRouter: Try live /v1/models with dual auth headers (Bearer + x-api-key + CC wire image).
    // If upstream returns 401/404 or fails, gracefully fall back to default catalog so sync never breaks.
    if (connection.provider === "agentrouter") {
      let warning;
      try {
        const token = connection.apiKey;
        if (token) {
          const headers = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "x-api-key": token,
            "User-Agent": "Claude-Code/0.2.29",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "prompt-caching-2024-07-31,interleaved-thinking-2025-05-14",
            "anthropic-dangerous-direct-browser-access": "true",
            "x-app": "cli",
          };
          const response = await fetch("https://agentrouter.org/v1/models", {
            method: "GET",
            headers,
          });
          if (response.ok) {
            const data = await response.json();
            const models = Array.isArray(data) ? data : data?.data || data?.models || [];
            if (models.length > 0) {
              return buildModelsResponse({
                provider: connection.provider,
                connectionId: connection.id,
                models: models.map((m) => typeof m === "string" ? { id: m, name: m } : { id: m.id || m.name, name: m.name || m.id }),
              });
            }
          } else {
            console.log(`AgentRouter /v1/models returned HTTP ${response.status}, falling back to built-in models.`);
          }
        }
      } catch (error) {
        console.log("AgentRouter models fetch error, falling back to built-in models:", error?.message);
      }

      // Return registered models so UI displays them immediately and cleanly
      const staticModels = PROVIDERS["agentrouter"]?.models || [];
      return buildModelsResponse({
        provider: connection.provider,
        connectionId: connection.id,
        models: staticModels.map((m) => typeof m === "string" ? { id: m, name: m } : { id: m.id || m.name, name: m.name || m.id, ...m }),
      });
    }

    // AiPASS TH: Fetch live models from de.aipass.net via connected Chrome extension bridge
    if (["aipass", "aipass-th", "aipass-bridge", "ap"].includes(connection.provider)) {
      let warning;
      try {
        const { listAipassModels, hasConnectedClients } = await import("open-sse/services/aipassBridge.js");
        const isConnected = hasConnectedClients();
        if (isConnected) {
          const liveModels = await listAipassModels({ force: true });
          if (Array.isArray(liveModels) && liveModels.length > 0) {
            const seen = new Set(liveModels.map((m) => m.id));
            const merged = [...liveModels];
            const staticModels = PROVIDERS["aipass"]?.models || [];
            for (const sm of staticModels) {
              const id = typeof sm === "string" ? sm : sm.id;
              if (id && !seen.has(id)) {
                seen.add(id);
                merged.push(typeof sm === "string" ? { id: sm, name: sm } : sm);
              }
            }
            return buildModelsResponse({
              provider: connection.provider,
              connectionId: connection.id,
              models: merged,
            });
          }
        } else {
          warning = "AiPASS Chrome extension not connected. Open de.aipass.net/chat in Chrome with the extension active to sync live models.";
        }
      } catch (error) {
        warning = `Failed to fetch AiPASS models: ${error?.message || error}`;
        console.log("Failed to fetch AiPASS models dynamically:", error?.message || error);
      }

      const staticModels = PROVIDERS["aipass"]?.models || [];
      // Do NOT stamp synced models on static fallback (so lastSyncedAt doesn't lie)
      return NextResponse.json({
        provider: connection.provider,
        connectionId: connection.id,
        models: staticModels.map((m) => typeof m === "string" ? { id: m, name: m } : { id: m.id || m.name, name: m.name || m.id, ...m }),
        warning,
      });
    }

    // Ollama Cloud: Fetch models from API
    // OpenCode: Fetch models from Zen Free or Zen Go API depending on API key presence
    if (connection.provider === "opencode" || connection.provider === "opencode-zen") {
      let warning;
      try {
        const url = "https://opencode.ai/zen/v1/models";
        const headers = {
          "Content-Type": "application/json",
          "x-opencode-client": "desktop",
          "Authorization": "Bearer public",
        };
        const response = await fetch(url, { headers });
        if (response.ok) {
          const data = await response.json();
          let models = parseOpenAIStyleModels(data);
          // Keep only free models for OpenCode / OpenCode Zen
          models = models.filter((m) => m.id.endsWith("-free") || m.id === "big-pickle");
          if (models.length > 0) {
            // opencode /zen/v1/models returns no modality — enrich vision/
            // reasoning/context from models.dev (authoritative) so text-only
            // models (e.g. deepseek-v4-flash-free) don't get image_url blocks
            // forwarded upstream (400 "unknown variant image_url"). Fail-open:
            // if models.dev is unreachable, models stay as-is (static table).
            const { enrichModalityFromModelsDev } = await import("open-sse/services/modelsDevModality.js");
            await enrichModalityFromModelsDev(models, "opencode");
            return buildModelsResponse({
              provider: connection.provider,
              connectionId: connection.id,
              models,
            });
          }
        } else {
          warning = `Failed to fetch OpenCode models: HTTP ${response.status}`;
        }
      } catch (error) {
        warning = `Failed to fetch OpenCode models: ${error.message}`;
        console.log("Failed to fetch OpenCode models dynamically:", error.message);
      }

      return buildModelsResponse({
        provider: connection.provider,
        connectionId: connection.id,
        models: [],
        warning,
      });
    }

    if (connection.provider === "ollama") {
      let warning;
      try {
        const ollamaService = new OllamaService();
        const accessToken = connection.accessToken || connection.apiKey;

        if (accessToken) {
          try {
            const models = await ollamaService.listAvailableModels(accessToken);
            return buildModelsResponse({
              provider: connection.provider,
              connectionId: connection.id,
              models,
            });
          } catch (error) {
            warning = `Failed to fetch Ollama models: ${error.message}`;
            console.log("Failed to fetch Ollama models dynamically, falling back to static:", error.message);
          }
        } else {
          warning = "No Ollama API key found";
        }
      } catch (error) {
        warning = `Ollama service error: ${error.message}`;
        console.log("Ollama service error:", error.message);
      }

      // Return empty dynamic list so UI falls back to static provider models
      return buildModelsResponse({
        provider: connection.provider,
        connectionId: connection.id,
        models: [],
        warning,
      });
    }

    if (connection.provider === "gemini-cli" || connection.provider === "antigravity") {
      const { accessToken, refreshToken } = connection;
      if (!accessToken) {
        return NextResponse.json({ error: "No valid token found" }, { status: 401 });
      }

      const projectId = connection.projectId || connection.providerSpecificData?.projectId;
      const body = projectId ? { project: projectId } : {};

      const userAgent = connection.provider === "antigravity"
        ? "antigravity/1.107.0 darwin/arm64"
        : "google-api-nodejs-client/9.15.1";
      const clientId = connection.provider === "antigravity"
        ? ANTIGRAVITY_CONFIG.clientId
        : GEMINI_CONFIG.clientId;
      const clientSecret = connection.provider === "antigravity"
        ? ANTIGRAVITY_CONFIG.clientSecret
        : GEMINI_CONFIG.clientSecret;

      const fetchModels = async (token) => {
        const headers = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "User-Agent": userAgent,
          ...(connection.provider === "antigravity" && {
            "X-Client-Name": "antigravity",
            "X-Client-Version": "2.1.1",
          }),
        };
        const urls = connection.provider === "antigravity"
          ? [
              "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
              GEMINI_CLI_MODELS_URL,
            ]
          : [GEMINI_CLI_MODELS_URL];

        for (const url of urls) {
          try {
            const res = await fetch(url, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
            });
            if (res.ok || res.status === 401) return res;
          } catch {
            // try next url
          }
        }
        return fetch(urls[0], { method: "POST", headers, body: JSON.stringify(body) });
      };

      let warning;

      try {
        let response = await fetchModels(accessToken);

        // Attempt refresh on 401 when refresh token exists
        if (!response.ok && response.status === 401 && refreshToken) {
          const refreshed = await refreshGoogleToken(refreshToken, clientId, clientSecret);
          if (refreshed?.accessToken) {
            await updateProviderCredentials(connection.id, {
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
              expiresIn: refreshed.expiresIn,
            });
            response = await fetchModels(refreshed.accessToken);
          }
        }

        if (response.ok) {
          const data = await response.json();
          let models = parseGeminiCliModels(data);

          // For antigravity, ensure newly released static registry models (such as Gemini 3.8/3.7 Flash variants)
          // are merged into the synced list so users can select and sync newly released models
          if (connection.provider === "antigravity" && PROVIDERS.antigravity?.models) {
            const seen = new Set(models.map((m) => m.id));
            for (const staticModel of PROVIDERS.antigravity.models) {
              if (/gemini-3/i.test(staticModel.id) && !seen.has(staticModel.id)) {
                seen.add(staticModel.id);
                models.push({
                  ...staticModel,
                  id: staticModel.id,
                  name: staticModel.name || staticModel.id,
                });
              }
            }
          }

          if (models.length > 0) {
            return buildModelsResponse({
              provider: connection.provider,
              connectionId: connection.id,
              models
            });
          }
        } else {
          const errorText = await response.text();
          // This warning reaches the client, so it gets the same sanitized
          // detail as the error paths — never the raw upstream body.
          warning = formatModelsFetchError(response.status, errorText).replace(
            "Failed to fetch models:",
            "Failed to fetch Gemini CLI models:"
          );
          console.log(
            "Failed to fetch Gemini CLI models dynamically, falling back to static:",
            safeLogDetail(response.status, errorText)
          );
        }
      } catch (error) {
        warning = `Failed to fetch Gemini CLI models: ${error.message}`;
        console.log("Failed to fetch Gemini CLI models dynamically, falling back to static:", error.message);
      }

      // Return empty dynamic list so UI falls back to static provider models.
      return buildModelsResponse({
        provider: connection.provider,
        connectionId: connection.id,
        models: [],
        warning,
      });
    }

    if (connection.provider === "ollama-local") {
      const url = `${resolveOllamaLocalHost(connection)}/api/tags`;
      const response = await fetch(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        const errorText = await response.text();
        console.log(`Error fetching models from ollama-local:`, safeLogDetail(response.status, errorText));
        return NextResponse.json(
          { error: formatModelsFetchError(response.status, errorText) },
          { status: response.status }
        );
      }
      const data = await response.json();
      const models = parseOpenAIStyleModels(data);
      return buildModelsResponse({
        provider: connection.provider,
        connectionId: connection.id,
        models,
      });
    }

    let config = PROVIDER_MODELS_CONFIG[connection.provider];
    const pDef = PROVIDERS[connection.provider];

    if (!config && pDef) {
      const baseUrl = pDef.baseUrl || pDef.transport?.baseUrl || "";
      const modelsUrl = pDef.transport?.validateUrl ||
        (baseUrl ? baseUrl.replace(/\/chat\/completions$/, "/models").replace(/\/conversation$/, "/models").replace(/\/messages$/, "/models") : "");

      if (modelsUrl) {
        config = {
          url: modelsUrl,
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            ...(pDef.transport?.headers || pDef.headers || {}),
          },
          authHeader: pDef.authHeader === "x-api-key" ? "x-api-key" : (pDef.authType === "none" ? undefined : "Authorization"),
          authPrefix: pDef.authHeader === "x-api-key" ? "" : (pDef.authType === "none" ? "" : "Bearer "),
          parseResponse: (data) => parseOpenAIStyleModels(data),
        };
      }
    }

    if (!config) {
      const staticModels = pDef?.models || [];
      if (staticModels.length > 0) {
        return buildModelsResponse({
          provider: connection.provider,
          connectionId: connection.id,
          models: staticModels.map((m) => typeof m === "string" ? { id: m, name: m } : { id: m.id || m.name, name: m.name || m.id, ...m }),
        });
      }
      return NextResponse.json(
        { error: `Provider ${connection.provider} does not support models listing` },
        { status: 400 }
      );
    }

    // Get auth token
    const token = connection.providerSpecificData?.copilotToken || connection.accessToken || connection.apiKey;
    if (!token && !isPublicModelsProvider(connection.provider)) {
      return NextResponse.json({ error: "No valid token found" }, { status: 401 });
    }

    const buildFetchRequest = (authToken, conn = connection) => {
      let requestUrl = config.url;
      if (conn.provider === "qwen") {
        requestUrl = resolveQwenModelsUrl(conn);
      }
      // Cloudflare Workers AI: account-scoped URL needs accountId from PSD.
      if (requestUrl.includes("{accountId}")) {
        const accountId = conn.providerSpecificData?.accountId;
        if (!accountId) {
          throw new Error("cloudflare-ai requires accountId in providerSpecificData");
        }
        requestUrl = requestUrl.replace("{accountId}", encodeURIComponent(accountId));
      }
      if (config.authQuery && authToken) {
        requestUrl += `?${config.authQuery}=${authToken}`;
      }

      const headers = { ...config.headers };
      if (config.authHeader && !config.authQuery && authToken) {
        headers[config.authHeader] = (config.authPrefix || "") + authToken;
      }

      const requestOptions = { method: config.method, headers };
      if (config.body && config.method === "POST") {
        requestOptions.body = JSON.stringify(config.body);
      }

      return { requestUrl, requestOptions };
    };

    let { requestUrl, requestOptions } = buildFetchRequest(token);
    let response;
    try {
      response = await fetch(requestUrl, requestOptions);
    } catch (networkErr) {
      console.log(`Network error fetching models from ${connection.provider}:`, networkErr?.message);
      const staticModels = pDef?.models || [];
      if (staticModels.length > 0) {
        return buildModelsResponse({
          provider: connection.provider,
          connectionId: connection.id,
          models: staticModels.map((m) => typeof m === "string" ? { id: m, name: m } : { id: m.id || m.name, name: m.name || m.id, ...m }),
        });
      }
      throw networkErr;
    }

    // OAuth providers (xai, qwen, codex, iflow, ...) use short-lived tokens that
    // chat requests refresh but this endpoint historically did not. Refresh and
    // retry once on 401/403; api-key providers have no refreshToken so this is a
    // no-op. github's bearer is a Copilot token minted separately from its OAuth
    // token (refreshing the OAuth token would not mint a new Copilot token), so
    // github is explicitly excluded below and not covered by this generic refresh.
    const usesCopilotToken = !!connection.providerSpecificData?.copilotToken;
    const isGoogleCliProvider = connection.provider === "antigravity" || connection.provider === "gemini-cli";
    const isRefreshableStatus = isGoogleCliProvider ? response.status === 401 : (response.status === 401 || response.status === 403);
    if (
      !response.ok &&
      isRefreshableStatus &&
      connection.refreshToken &&
      !usesCopilotToken
    ) {
      try {
        const refreshed = await refreshProviderCredentials(connection.provider, connection, console);

        if (refreshed?.accessToken) {
          await updateProviderCredentials(connection.id, refreshed);

          const refreshedConn = refreshed.providerSpecificData
            ? {
                ...connection,
                ...refreshed,
                providerSpecificData: {
                  ...connection.providerSpecificData,
                  ...refreshed.providerSpecificData,
                },
              }
            : connection;

          ({ requestUrl, requestOptions } = buildFetchRequest(refreshed.accessToken, refreshedConn));
          response = await fetch(requestUrl, requestOptions);
        }
      } catch (refreshError) {
        console.log(`Error refreshing token for ${connection.provider}:`, refreshError);
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`Error fetching models from ${connection.provider}:`, safeLogDetail(response.status, errorText));
      const staticModels = pDef?.models || [];
      const isPublic = connection.id?.startsWith("public:") || isPublicModelsProvider(connection.provider);
      if (staticModels.length > 0 && isPublic) {
        return buildModelsResponse({
          provider: connection.provider,
          connectionId: connection.id,
          models: staticModels.map((m) => typeof m === "string" ? { id: m, name: m } : { id: m.id || m.name, name: m.name || m.id, ...m }),
        });
      }
      return NextResponse.json(
        { error: formatModelsFetchError(response.status, errorText) },
        { status: response.status }
      );
    }

    const data = await response.json();
    const parsed = config.parseResponse(data);
    const models = (Array.isArray(parsed) && parsed.length > 0) ? parsed : (pDef?.models || []);

    return buildModelsResponse({
      provider: connection.provider,
      connectionId: connection.id,
      models
    });
  } catch (error) {
    console.log("Error fetching provider models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}
