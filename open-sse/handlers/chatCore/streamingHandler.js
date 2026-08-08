import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { PROVIDERS } from "../../config/providers.js";
import { STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes, buildAbortedClaudeTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats } from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.js";
import { createStreamToolShimTransformStream } from "../../transformer/streamToolShim.js";

// Codex returns Responses API SSE → which client format to translate INTO, by request sourceFormat.
// Gemini-family all map to ANTIGRAVITY decoder; unknown sources fall back to OPENAI.
const CODEX_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey }) {
  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  // Responses-API providers (e.g. codex) emit Responses SSE → translate into client format
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;

  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey);
  }

  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey);
  }

  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey);
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 */
export async function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, log, toolNameMap, streamController, onStreamComplete, streamDetailId, prunerStats = null, rtkStats = null, headroomStats = null, headroomDiagnostics = null, clientModel = null, universalToolsMode }) {
  if (onRequestSuccess) {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  }

  const upstreamContentType = (providerResponse.headers.get('content-type') || '').toLowerCase();
  // Upstream returned 200 with an empty/stalled body (proxy-pool stream with
  // Content-Length: 0 or a null body). Do not pipe an empty stream to the
  // client — synthesise an error so the caller can fall through / re-rotate.
  const upstreamContentLength = providerResponse.headers.get('content-length');
  if (providerResponse.status >= 200 && providerResponse.status < 300 && (upstreamContentLength === '0' || providerResponse.body === null)) {
    console.warn(`[STREAM] ${provider} | ${model} | empty body (content-length: ${upstreamContentLength || '0'}, status ${providerResponse.status}), treating as failure`);
    streamController?.handleError?.(new Error(`upstream empty body: ${providerResponse.status}`));
    return {
      success: false,
      response: new Response(JSON.stringify({ error: { message: `Upstream returned an empty response (${providerResponse.status})` } }), {
        status: providerResponse.status || 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }),
    };
  }

  if (upstreamContentType && !upstreamContentType.includes('text/event-stream') && !upstreamContentType.includes('application/json')) {
    const bodyText = await providerResponse.text().catch(() => '');
    const titleMatch = bodyText.match(/<title>([^<]+)<\/title>/i);
    const sanitizedTitle = (titleMatch?.[1] || '').replace(/<[^>]*>/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
    const shortMsg = sanitizedTitle
      || (bodyText.length < 200 ? bodyText.replace(/<[^>]*>/g, '').trim().slice(0, 160) : `Upstream returned non-SSE response (${upstreamContentType})`);
    const status = providerResponse.status || 502;
    console.warn(`[STREAM] ${provider} | ${model} | blocked pipe: ${shortMsg} [${status}]`);
    streamController?.handleError?.(new Error(`upstream non-SSE: ${status}`));
    return {
      success: false,
      response: new Response(JSON.stringify({ error: { message: `[${status}]: ${shortMsg}` } }), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }),
    };
  }

  const transformStream = buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey });

  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  const isClaudeTarget = targetFormat === FORMATS.CLAUDE;
  const onAbortTerminal = isResponsesPassthrough
    ? buildAbortedResponsesTerminalBytes
    : isClaudeTarget
      ? buildAbortedClaudeTerminalBytes
      : null;
  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;
  const declaredTools = translatedBody?._declaredTools
    || body?._declaredTools
    || (Array.isArray(body?.tools) ? body.tools : (Array.isArray(translatedBody?.tools) ? translatedBody.tools : []));
  const hasTools = (declaredTools && declaredTools.length > 0) || translatedBody?._universalToolPromptInjected || body?._universalToolPromptInjected;

  let transform = transformStream;
  // Gate the tool shim on the effective universal tools mode: when "off", do
  // NOT run the shim even if tools are present — the shim itself is what
  // causes "Content block not found" on some clients. Injection (request-side)
  // is already gated; this closes the response/stream-side gap so "off" truly
  // disables the whole universal-tools path.
  const toolsEnabled = universalToolsMode !== "off";
  if (toolsEnabled && hasTools) {
    // Chain the universal tool shim AFTER the translator transform but BEFORE
    // pipeWithDisconnect. Composing via readable.pipeThrough(shim) keeps the
    // disconnect stream's scanForBlockEvents() downstream of the shim, so it
    // sees the tool_use content blocks the shim allocates. If the shim ran
    // after pipeWithDisconnect (as a separate downstream pipe), an upstream
    // abort would synthesize message_stop while those shim-created blocks are
    // still open → Claude Code: "Content block not found".
    const shim = createStreamToolShimTransformStream(declaredTools, sourceFormat, log);
    transform = {
      readable: transformStream.readable.pipeThrough(shim),
      writable: transformStream.writable
    };
  }

  let outputStream = pipeWithDisconnect(providerResponse, transform, streamController, onAbortTerminal, stallTimeoutMs);

  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId, clientModel,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    status: "success",
    prunerStats,
    rtkStats,
    headroomStats,
    headroomDiagnostics,
  }, { id: streamDetailId })).catch(err => {
    console.error("[RequestDetail] Failed to save streaming request:", err.message);
  });

  return {
    success: true,
    response: new Response(outputStream, { headers: SSE_HEADERS })
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest, detailId = null, prunerStats = null, rtkStats = null, headroomStats = null, headroomDiagnostics = null, clientModel = null }) {
  const streamDetailId = detailId || `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  // Reasoning models (deepseek/kimi/…) can stream ONLY thinking deltas then
  // end with finish_reason "length" and no text. onStreamComplete then gets an
  // empty contentObj. When the whole stream ends without a single text chunk,
  // surface it here: log + label so combos/ops can see it, and downstream
  // decides (comboStreamGuard already handles the combo path before the head
  // reaches the client; single-model clients get an accurate status here).
  const onStreamComplete = (contentObj, streamUsage, ttftAt) => {
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const hasText = typeof contentObj?.content === "string" && contentObj.content.length > 0;
    const safeContent = hasText ? contentObj.content : "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;

    // An empty streamed reply (reasoning model exhausted budget on thinking)
    // is a real failure from the client's perspective even though upstream
    // returned 200. Mark it so single-model requests get an traceable row and
    // combos observe it (the comboStreamGuard path already prevents this from
    // reaching the client for combos; single-model requests rely on this log).
    const status = hasText ? "success" : "empty";
    const note = hasText ? null : { reason: "empty-stream-content", finishReason: contentObj?.finishReason || null };

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId, clientModel: clientModel || clientRawRequest?.body?.model || null,
      latency,
      tokens: streamUsage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: { content: safeContent, thinking: safeThinking, type: "streaming", note },
      status,
      prunerStats,
      rtkStats,
      headroomStats,
      headroomDiagnostics,
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to update streaming content:", err.message);
    });

    saveUsageStats({ provider, model, tokens: streamUsage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, label: "STREAM USAGE" });
  };

  return { onStreamComplete, streamDetailId };
}
