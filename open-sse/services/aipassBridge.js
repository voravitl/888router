import crypto from "crypto";

const bridgeState = globalThis.__AIPASS_BRIDGE__ || (globalThis.__AIPASS_BRIDGE__ = {
  jobs: new Map(),
  extClients: new Set(),
  roundRobinIndex: 0,
  defaultModel: "gemini-3.1-flash-lite",
});

const jobs = bridgeState.jobs;
const extClients = bridgeState.extClients;

export function getBridgeDefaultModel() {
  return bridgeState.defaultModel || "gemini-3.1-flash-lite";
}

export function setBridgeDefaultModel(model) {
  if (typeof model === "string" && model.trim()) {
    bridgeState.defaultModel = model.trim();
  }
  return bridgeState.defaultModel;
}

const LOADERS = {
  models: "/loaders/list-models.data?_routes=routes%2Floaders%2Flist-models",
  conversations: "/loaders/list-conversations.data?_routes=routes%2Floaders%2Flist-conversations",
  quota: "/loaders/get-usage-quota",
};

const KINDS = [
  ["image", /seedream|gpt-image|-image$|image-preview/i],
  ["video", /^veo-|seedance/i],
  ["music", /lyria/i],
  ["research", /deep-research/i],
];

export function kindOf(id) {
  return KINDS.find(([, re]) => re.test(id))?.[0] ?? "chat";
}

/**
 * Turbo-stream decoder for React Router loaders used by de.aipass.net
 */
export function decodeTurboStream(text) {
  if (!text || typeof text !== "string") return null;
  let flat;
  try {
    flat = JSON.parse(text);
  } catch {
    return null;
  }
  const seen = new Map();
  const resolve = (ref) => {
    if (typeof ref !== "number") return ref;
    if (ref < 0) return null; // null / undefined sentinels
    if (seen.has(ref)) return seen.get(ref);
    const v = flat[ref];
    if (Array.isArray(v)) {
      const out = [];
      seen.set(ref, out);
      for (const e of v) out.push(resolve(e));
      return out;
    }
    if (v && typeof v === "object") {
      const out = {};
      seen.set(ref, out);
      for (const [k, valueRef] of Object.entries(v)) {
        if (k.startsWith("_") && !isNaN(Number(k.slice(1)))) {
          const resolvedKey = resolve(Number(k.slice(1)));
          out[typeof resolvedKey === "string" ? resolvedKey : k] = resolve(valueRef);
        } else {
          out[k] = resolve(valueRef);
        }
      }
      return out;
    }
    seen.set(ref, v);
    return v;
  };
  return resolve(0);
}

function findValue(node, key) {
  if (Array.isArray(node)) {
    for (const v of node) {
      const hit = findValue(v, key);
      if (hit != null) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if (typeof node[key] === "string") return node[key];
  for (const v of Object.values(node)) {
    const hit = findValue(v, key);
    if (hit != null) return hit;
  }
  return null;
}

export function extractModels(decoded) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const id = v.id ?? v.modelId;
    if (typeof id === "string" && id && !out.some((m) => m.id === id)) {
      const rawKind = kindOf(id);
      const kind = rawKind === "chat" || rawKind === "research" ? "llm" : rawKind;
      out.push({
        id,
        name: v.displayName ?? v.name ?? id,
        provider: v.providerName ?? v.provider ?? null,
        providerId: v.provider ?? null,
        description: v.description ?? null,
        kind,
        free: v.isFreeCredit === true,
        ready: v.ready !== false,
        selectable: v.selectable !== false,
        isDefault: v.isDefault === true,
        thinking: Array.isArray(v.thinkingConfig?.supportedLevels) ? v.thinkingConfig.supportedLevels : null,
        media: rawKind !== "chat" && rawKind !== "research",
      });
    }
    Object.values(v).forEach(walk);
  };
  walk(decoded);
  return out.filter((m) => m.ready && m.selectable);
}

function pickClient() {
  const list = [...extClients];
  if (!list.length) return null;
  return list[bridgeState.roundRobinIndex++ % list.length];
}

function sendToClient(client, event, data) {
  if (!client || typeof client.send !== "function") return;
  try {
    client.send(event, data);
  } catch (err) {
    if (typeof client.unregister === "function") {
      client.unregister();
    }
  }
}

export function parsePart(part) {
  if (!part || typeof part !== "object") {
    if (typeof part === "string") {
      return { partType: "text", textContent: part, thoughtContent: "", fileContent: "" };
    }
    return { partType: "text", textContent: "", thoughtContent: "", fileContent: "" };
  }
  const partType = part.kind || part.type || "text";
  const rawText = part.text || part.content || "";
  const isThought = partType === "reasoning" || partType === "thought";
  const isMedia = partType === "image" || partType === "file";
  const textContent = isThought ? "" : rawText;
  const thoughtContent = part.thought || part.reasoning || (isThought ? rawText : "");
  const fileContent = part.data || part.url || part.mediaUrl || (isMedia ? rawText : "");
  return { partType, textContent, thoughtContent, fileContent };
}

export function createBridgeJob(params) {
  return new BridgeJob(params);
}

export class BridgeJob {
  constructor({
    kind = "chat",
    modelId,
    text,
    parts,
    conversationId,
    aspectRatio = "1:1",
    url,
    message,
    requestId,
    assistant,
    assistantField = "aiAssistantId",
    timeoutMs = 120_000,
    onDelta,
    onDone,
    onError,
  }) {
    this.id = crypto.randomUUID();
    this.kind = kind;
    this.url = url;
    this.message = message;
    this.requestId = requestId;
    this.assistant = assistant;
    this.assistantField = assistantField;
    this.modelId = modelId;
    this.text = text;
    this.parts = parts;
    this.conversationId = conversationId;
    this.aspectRatio = aspectRatio;
    this.onDelta = onDelta || (() => {});
    this.onDone = onDone || (() => {});
    this.onError = onError || (() => {});
    this.settled = false;
    this.client = null;
    this.timeoutMs = timeoutMs;
    this.touch();
    jobs.set(this.id, this);
  }

  touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail("job timed out waiting for upstream response"), this.timeoutMs);
  }

  dispatch() {
    if (this.settled) return;
    try {
      const client = pickClient();
      if (!client) {
        return this.fail("no extension connected — open a de.aipass.net tab and check the popup");
      }
      this.client = client;
      if (this.kind === "loader") {
        sendToClient(client, "job", { jobId: this.id, kind: "loader", url: this.url });
      } else if (this.kind === "create") {
        sendToClient(client, "job", {
          jobId: this.id,
          kind: "create",
          modelId: this.modelId,
          message: this.message,
          requestId: this.requestId,
          assistant: this.assistant,
          assistantField: this.assistantField,
        });
      } else {
        sendToClient(client, "job", {
          jobId: this.id,
          kind: "chat",
          conversationId: this.conversationId,
          modelId: this.modelId,
          text: this.text,
          parts: this.parts,
          aspectRatio: this.aspectRatio,
        });
      }
    } catch (err) {
      this.fail(err);
    }
  }

  delta(part) {
    if (!this.settled) {
      this.touch();
      this.onDelta(part);
    }
  }

  done(value) {
    if (this.settled) return;
    this.cleanup();
    this.onDone(value ?? "stop");
  }

  fail(message) {
    if (this.settled) return;
    this.cleanup();
    const err = message instanceof Error ? message : new Error(String(message || "job failed"));
    this.onError(err);
  }

  abort() {
    if (this.settled) return;
    if (this.client) sendToClient(this.client, "abort", { jobId: this.id });
    this.fail("job aborted");
  }

  cleanup() {
    this.settled = true;
    clearTimeout(this.timer);
    jobs.delete(this.id);
  }
}

const MAX_EXT_CLIENTS = 10;

// Client registration
export function registerExtClient(client) {
  if (extClients.size >= MAX_EXT_CLIENTS) {
    const oldest = extClients.values().next().value;
    if (oldest) {
      extClients.delete(oldest);
      for (const job of jobs.values()) {
        if (job.client === oldest) {
          job.client = null;
          job.fail("client disconnected due to connection pool limit");
        }
      }
      if (typeof oldest.close === "function") {
        try { oldest.close(); } catch (_) {}
      }
    }
  }

  extClients.add(client);
  sendToClient(client, "ready", { clientId: client.id });

  return () => {
    extClients.delete(client);
    for (const job of jobs.values()) {
      if (job.client === client) {
        job.client = null;
        job.fail("client disconnected mid-job");
      }
    }
  };
}

export function hasConnectedClients() {
  return extClients.size > 0;
}

export function getClientCount() {
  return extClients.size;
}

// Events posted by extension
export function handleExtChunk(body) {
  const job = jobs.get(body?.jobId);
  if (!job) return false;
  const rawParts = Array.isArray(body.parts)
    ? body.parts
    : body.part !== undefined
    ? [body.part]
    : typeof body.parts === "string"
    ? [body.parts]
    : [];
  for (const part of rawParts) {
    const normalized = typeof part === "string" ? { kind: "text", text: part } : part;
    job.delta(normalized);
  }
  return true;
}

export function handleExtDone(body) {
  const job = jobs.get(body?.jobId);
  if (!job) return false;
  job.done(body.finishReason);
  return true;
}

export function handleExtError(body) {
  const job = jobs.get(body?.jobId);
  if (!job) return false;
  job.fail(body.message ?? "extension reported an error");
  return true;
}

export function handleExtLoader(body) {
  const job = jobs.get(body?.jobId);
  if (!job) return false;
  if (typeof body.raw === "string") {
    job.done(body.raw);
  } else {
    job.fail(body.message ?? "loader fetch failed");
  }
  return true;
}

// Model & conversation caching
// Model & conversation caching stored on bridgeState
bridgeState.modelCache = bridgeState.modelCache || { at: 0, models: [] };
bridgeState.conversationList = bridgeState.conversationList || [];
bridgeState.conversationIndex = bridgeState.conversationIndex || 0;
bridgeState.conversationCache = bridgeState.conversationCache || null;

export async function fetchLoader(url, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const job = new BridgeJob({
      kind: "loader",
      url,
      timeoutMs,
      onDelta: () => {},
      onDone: resolve,
      onError: (m) => reject(new Error(m)),
    });
    job.dispatch();
  });
}

export async function listAipassModels({ force = false } = {}) {
  if (!force && bridgeState.modelCache.models.length && Date.now() - bridgeState.modelCache.at < 60_000) {
    return bridgeState.modelCache.models;
  }
  if (!extClients.size) return bridgeState.modelCache.models;

  try {
    const raw = await fetchLoader(LOADERS.models);
    const decoded = decodeTurboStream(raw);
    const models = extractModels(decoded);
    if (models.length) {
      bridgeState.modelCache = { at: Date.now(), models };
    }
    return models;
  } catch (err) {
    console.log("[AiPASS Bridge] Model refresh failed:", err.message);
    return bridgeState.modelCache.models;
  }
}

export async function createAipassConversation({ modelId = getBridgeDefaultModel(), message = "Hello" } = {}) {
  const requestId = crypto.randomUUID();
  const raw = await new Promise((resolve, reject) => {
    const job = new BridgeJob({
      kind: "create",
      modelId,
      message,
      requestId,
      timeoutMs: 30_000,
      onDelta: () => {},
      onDone: resolve,
      onError: (m) => reject(new Error(m)),
    });
    job.dispatch();
  });
  const decoded = decodeTurboStream(raw);
  let id = findValue(decoded, "conversationId");
  if (!id || typeof id !== "string" || id.length < 16) {
    const walk = (v) => {
      if (id) return;
      if (Array.isArray(v)) return v.forEach(walk);
      if (!v || typeof v !== "object") return;
      if (typeof v.id === "string" && v.id.length >= 16 && (v.title || v.createdAt || v.updatedAt || v.messages)) {
        id = v.id;
        return;
      }
      Object.values(v).forEach(walk);
    };
    walk(decoded);
  }
  if (!id || typeof id !== "string" || id.length < 16) {
    throw new Error(`Could not read valid conversationId from upstream: ${String(raw).slice(0, 200)}`);
  }
  bridgeState.conversationCache = id;
  return id;
}

export async function loadAipassConversations() {
  if (!extClients.size) return [];
  try {
    let raw;
    try {
      raw = await fetchLoader(LOADERS.conversations);
    } catch {
      raw = await fetchLoader("/loaders/list-conversations.data?_routes=routes%2Floaders%2Flist-conversations");
    }
    const decoded = decodeTurboStream(raw);
    const list = [];
    const walk = (v) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (!v || typeof v !== "object") return;
      if (typeof v.id === "string" && v.id.length >= 16 && (v.title || v.createdAt || v.updatedAt)) {
        if (!list.some((c) => c.id === v.id)) {
          list.push({ id: v.id, title: v.title ?? null, updatedAt: v.updatedAt ?? null });
        }
      }
      Object.values(v).forEach(walk);
    };
    walk(decoded);
    bridgeState.conversationList = list;
    return list;
  } catch {
    return [];
  }
}

export async function resolveAipassConversation() {
  if (bridgeState.conversationCache) return bridgeState.conversationCache;
  if (!bridgeState.conversationList.length) await loadAipassConversations();
  const pick = bridgeState.conversationList[bridgeState.conversationIndex];
  if (pick?.id) {
    bridgeState.conversationCache = pick.id;
    return bridgeState.conversationCache;
  }
  return await createAipassConversation();
}

export function advanceAipassConversation() {
  bridgeState.conversationIndex++;
  bridgeState.conversationCache = null;
}

export async function getAipassQuota() {
  if (!extClients.size) return null;
  try {
    const raw = await fetchLoader(LOADERS.quota);
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    const credits = data?.creditStatus?.credits;
    const decimals = Number(data?.creditStatus?.creditsDecimals ?? 6);
    const factor = Math.pow(10, decimals);
    const limit = Number(credits?.limit ?? 0) / factor;
    const used = Number(credits?.used ?? 0) / factor;
    const available = Number(credits?.available ?? 0) / factor;
    return {
      limit,
      used,
      available,
      periodEndsAt: data?.creditStatus?.periodEndsAt || null,
      raw: data,
    };
  } catch (err) {
    console.log("[AiPASS Bridge] Quota fetch error:", err.message);
    return null;
  }
}
