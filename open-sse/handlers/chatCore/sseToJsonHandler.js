import { convertResponsesStreamToJson } from "../../transformer/streamToJsonConverter.js";
import { createErrorResult } from "../../utils/error.js";
import { isClientAbort } from "../../utils/abort.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { FORMATS } from "../../translator/formats.js";
import { PROVIDERS } from "../../config/providers.js";
import { buildRequestDetail, extractRequestConfig, extractUsageFromResponse, saveUsageStats } from "./requestDetail.js";

// Responses-API providers (e.g. codex) may emit SSE without content-type + use Responses output shape
const isResponsesProvider = (p) => PROVIDERS[p]?.format === FORMATS.OPENAI_RESPONSES;
import { saveRequestDetail, appendRequestLog } from "@/lib/usageDb.js";
import { parseUniversalToolCalls, getDeclaredToolNames } from "../../translator/concerns/universalToolParser.js";

function textFromResponsesMessageItem(item) {
  if (!item?.content || !Array.isArray(item.content)) return "";
  return item.content.filter((part) => typeof part?.text === "string").map((part) => part.text).join("");
}

/**
 * Codex / Responses API may emit many alternating reasoning + message items.
 * Early message blocks often have empty output_text; the user-visible answer is usually in the last non-empty message.
 */
function pickAssistantMessageForChatCompletion(output) {
  if (!Array.isArray(output)) return { msgItem: null, textContent: null };
  const messages = output.filter((item) => item?.type === "message");
  if (messages.length === 0) return { msgItem: null, textContent: null };
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = textFromResponsesMessageItem(messages[i]);
    if (text.length > 0) return { msgItem: messages[i], textContent: text };
  }
  const last = messages[messages.length - 1];
  return { msgItem: last, textContent: textFromResponsesMessageItem(last) };
}

/**
 * Parse OpenAI-style SSE text into a single chat completion JSON.
 * Used when provider forces streaming but client wants non-streaming.
 */
export function parseSSEToOpenAIResponse(rawSSE, fallbackModel) {
  const chunks = [];
  let streamError = null;
  let hasTerminal = false;

  for (const line of String(rawSSE || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") { hasTerminal = true; continue; }
    if (!payload) continue;
    try {
      const chunk = JSON.parse(payload);
      if (chunk?.choices?.some((choice) => choice.finish_reason)) hasTerminal = true;
      if (chunk?.error) streamError = chunk.error;
      else chunks.push(chunk);
    } catch { /* ignore malformed lines */ }
  }

  if (streamError) return { error: streamError };
  if (chunks.length === 0 || !hasTerminal || !chunks.some((chunk) => chunk.choices?.length)) return null;

  const first = chunks[0];
  const contentParts = [];
  const reasoningParts = [];
  const toolCallMap = new Map(); // index -> { id, type, function: { name, arguments } }
  let finishReason = "stop";
  let usage = null;

  for (const chunk of chunks) {
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta || {};
    if (typeof delta.content === "string" && delta.content.length > 0) contentParts.push(delta.content);
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) reasoningParts.push(delta.reasoning_content);
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk?.usage && typeof chunk.usage === "object") usage = chunk.usage;

    // Accumulate tool_calls from streaming deltas
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallMap.has(idx)) {
          toolCallMap.set(idx, { id: tc.id || "", type: "function", function: { name: "", arguments: "" } });
        }
        const existing = toolCallMap.get(idx);
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.function.name += tc.function.name;
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
      }
    }
  }

  const message = { role: "assistant", content: contentParts.join("") || (toolCallMap.size > 0 ? null : "") };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");
  if (toolCallMap.size > 0) {
    message.tool_calls = [...toolCallMap.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc);
  }

  const result = {
    id: first.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: first.created || Math.floor(Date.now() / 1000),
    model: first.model || fallbackModel || "unknown",
    choices: [{ index: 0, message, finish_reason: finishReason }]
  };
  if (usage) result.usage = usage;
  return result;
}

function parseExecutableToolArguments(value, incomplete) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value || "{}") : (value ?? {});
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid tool argument object");
    return parsed;
  } catch (error) {
    if (incomplete) return null;
    throw error;
  }
}

/**
 * Handle case: provider forced streaming but client wants JSON.
 * Supports both Codex/Responses API SSE and standard Chat Completions SSE.
 */
export async function handleForcedSSEToJson({ providerResponse, sourceFormat, targetFormat, provider, model, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, trackDone, appendLog, prunerStats = null, rtkStats = null, headroomStats = null, headroomDiagnostics = null, detailId = null, clientModel = null, universalToolsMode }) {
  const contentType = providerResponse.headers.get("content-type") || "";
  const isSSE = contentType.includes("text/event-stream") || (contentType === "" && isResponsesProvider(provider));
  if (!isSSE) return null; // not handled here

  trackDone();

  const ctx = {
    provider, model, connectionId,
    clientModel: clientModel || clientRawRequest?.body?.model || null,
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    prunerStats,
    rtkStats,
    headroomStats,
    headroomDiagnostics,
  };
  const detailOverrides = { endpoint: clientRawRequest?.endpoint || null, ...(detailId ? { id: detailId } : {}) };

  const finishSuccess = async (clientResponse, rawProviderResponse, usage, summary) => {
    // Construct/serialize the client result before recording success or clearing
    // account errors. Malformed conversion must not leave success telemetry.
    const response = new Response(JSON.stringify(clientResponse), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    if (onRequestSuccess) await onRequestSuccess();
    appendLog({ tokens: usage, status: "200 OK" });
    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint });
    const totalLatency = Date.now() - requestStartTime;
    saveRequestDetail(buildRequestDetail({
      ...ctx, providerResponse: structuredClone(rawProviderResponse),
      latency: { ttft: totalLatency, total: totalLatency },
      tokens: extractUsageFromResponse(rawProviderResponse) || usage,
      response: summary, status: "success",
    }, detailOverrides)).catch(() => {});
    return { success: true, response };
  };

  // Codex/Responses API SSE path
  const isCodexResponsesApi = targetFormat === FORMATS.OPENAI_RESPONSES || (!targetFormat && isResponsesProvider(provider));
  if (isCodexResponsesApi) {
    try {
      const jsonResponse = await convertResponsesStreamToJson(providerResponse.body);
      if (jsonResponse.error || jsonResponse.status === "failed" || jsonResponse.status === "in_progress") {
        return createErrorResult(HTTP_STATUS.BAD_GATEWAY, jsonResponse.error?.message || "Upstream Responses stream did not complete");
      }
      const usage = jsonResponse.usage || {};
      const { textContent } = pickAssistantMessageForChatCompletion(jsonResponse.output);
      const summary = { content: textContent, thinking: null, finish_reason: jsonResponse.status || "unknown" };

      // Client is Responses API → return as-is
      if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
        return await finishSuccess(jsonResponse, jsonResponse, usage, summary);
      }

      // Build client-format response
      const inTokens = usage.input_tokens || 0;
      const outTokens = usage.output_tokens || 0;
      let finalResp;

      // Extract tool calls from Responses API output (function_call items)
      const funcCallItems = (jsonResponse.output || []).filter(item => item.type === "function_call");
      const toolCalls = funcCallItems.map((item, idx) => ({
        id: item.call_id || `call_${item.name}_${Date.now()}_${idx}`,
        type: "function",
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {})
        }
      }));
      const hasToolCalls = toolCalls.length > 0;

      if (sourceFormat === FORMATS.CLAUDE) {
        if (jsonResponse.status === "incomplete" && jsonResponse.incomplete_details?.reason === "content_filter") {
          return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Upstream response blocked by content filter");
        }
        const content = [];
        const thinking = (jsonResponse.output || []).filter((item) => item.type === "reasoning")
          .flatMap((item) => item.summary || []).map((part) => part.text || "").join("");
        // Foreign reasoning has no Anthropic signature; preserve it as text.
        // https://platform.claude.com/docs/en/build-with-claude/thinking
        if (thinking) content.push({ type: "text", text: thinking });
        if (textContent) {
          content.push({ type: "text", text: textContent });
        }
        for (const tc of toolCalls) {
          const parsedArgs = parseExecutableToolArguments(tc.function.arguments, jsonResponse.status === "incomplete");
          if (parsedArgs === null) continue;
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: parsedArgs
          });
        }
        if (content.length === 0) {
          content.push({ type: "text", text: "" });
        }
        const responseDone = jsonResponse.status === "completed" || jsonResponse.status === "done";
        const stopReason = jsonResponse.status === "incomplete" ? "max_tokens"
          : (hasToolCalls ? "tool_use" : (responseDone ? "end_turn" : (jsonResponse.status || "end_turn")));
        finalResp = {
          id: String(jsonResponse.id || `msg_${Date.now()}`).replace(/^chatcmpl-/, ""),
          type: "message",
          role: "assistant",
          model: jsonResponse.model || model,
          content,
          stop_reason: stopReason,
          stop_sequence: null,
          usage: {
            input_tokens: Math.max(0, inTokens - (usage.input_tokens_details?.cached_tokens || 0)),
            output_tokens: outTokens,
            ...(usage.input_tokens_details?.cached_tokens !== undefined && { cache_read_input_tokens: usage.input_tokens_details.cached_tokens }),
            ...(usage.estimated !== undefined && { estimated: usage.estimated }),
          }
        };
      } else if (sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI) {
        const parts = textContent ? [{ text: textContent }] : [];
        for (const tc of toolCalls) {
          const args = parseExecutableToolArguments(tc.function.arguments, jsonResponse.status === "incomplete");
          if (args !== null) parts.push({ functionCall: { name: tc.function.name, args } });
        }
        if (parts.length === 0) parts.push({ text: "" });
        const geminiResponse = {
          candidates: [{ content: { role: "model", parts }, finishReason: jsonResponse.status === "incomplete"
            ? (jsonResponse.incomplete_details?.reason === "content_filter" ? "SAFETY" : "MAX_TOKENS") : "STOP", index: 0 }],
          usageMetadata: {
            // Gemini candidates exclude reasoning, which has its own counter.
            // https://ai.google.dev/api/generate-content#UsageMetadata
            promptTokenCount: inTokens, candidatesTokenCount: Math.max(0, outTokens - (usage.output_tokens_details?.reasoning_tokens || 0)),
            totalTokenCount: usage.total_tokens ?? inTokens + outTokens,
            ...(usage.input_tokens_details?.cached_tokens !== undefined && { cachedContentTokenCount: usage.input_tokens_details.cached_tokens }),
            ...(usage.output_tokens_details?.reasoning_tokens !== undefined && { thoughtsTokenCount: usage.output_tokens_details.reasoning_tokens }),
            ...(usage.estimated !== undefined && { estimated: usage.estimated }),
          },
          modelVersion: jsonResponse.model || model,
          responseId: jsonResponse.id || `resp_${Date.now()}`,
        };
        finalResp = sourceFormat === FORMATS.GEMINI ? geminiResponse : { response: geminiResponse };
      } else {
        const message = { role: "assistant", content: textContent || (hasToolCalls ? null : "") };
        if (hasToolCalls) message.tool_calls = toolCalls;
        const responseDone = jsonResponse.status === "completed" || jsonResponse.status === "done";
        const finishReason = jsonResponse.status === "incomplete"
          ? (jsonResponse.incomplete_details?.reason === "content_filter" ? "content_filter" : "length")
          : (hasToolCalls ? "tool_calls" : (responseDone ? "stop" : (jsonResponse.status || "stop")));
        finalResp = {
          id: jsonResponse.id || `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: jsonResponse.created_at || Math.floor(Date.now() / 1000),
          model: jsonResponse.model || model,
          choices: [{ index: 0, message, finish_reason: finishReason }],
          usage: {
            prompt_tokens: inTokens, completion_tokens: outTokens, total_tokens: usage.total_tokens ?? inTokens + outTokens,
            ...(usage.input_tokens_details && { prompt_tokens_details: structuredClone(usage.input_tokens_details) }),
            ...(usage.output_tokens_details && { completion_tokens_details: structuredClone(usage.output_tokens_details) }),
            ...(usage.estimated !== undefined && { estimated: usage.estimated }),
          }
        };
      }

      return await finishSuccess(finalResp, jsonResponse, usage, summary);
    } catch (err) {
      // Client went away mid-read: a 499, not a provider 502 (#517).
      if (isClientAbort(err)) return createErrorResult(499, "Request aborted");
      console.error("[ChatCore] Responses API SSE→JSON failed:", err);
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Failed to convert streaming response to JSON");
    }
  }

  // Standard Chat Completions SSE path
  try {
    const sseText = await providerResponse.text();
    const parsed = parseSSEToOpenAIResponse(sseText, model);
    if (!parsed) return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid SSE response for non-streaming request");
    if (parsed.error) {
      return createErrorResult(
        HTTP_STATUS.BAD_GATEWAY,
        parsed.error.message || "Upstream SSE stream failed"
      );
    }

    const usage = parsed.usage || {};
    const rawProviderResponse = structuredClone(parsed);
    const summary = {
      content: parsed.choices?.[0]?.message?.content || null,
      thinking: parsed.choices?.[0]?.message?.reasoning_content || null,
      finish_reason: parsed.choices?.[0]?.finish_reason || "unknown",
    };

    // Universal Tool Engine parsing for forced SSE-to-JSON path
    const declaredToolsList = translatedBody?._declaredTools
      || body?._declaredTools
      || (Array.isArray(body?.tools) ? body.tools : (Array.isArray(translatedBody?.tools) ? translatedBody.tools : []));
    const hasToolsInRequest = (declaredToolsList && declaredToolsList.length > 0) || translatedBody?._universalToolPromptInjected || body?._universalToolPromptInjected;

    if (universalToolsMode !== "off" && hasToolsInRequest && parsed?.choices?.[0]?.message?.content) {
      const choice = parsed.choices[0];
      const declaredNames = getDeclaredToolNames(declaredToolsList);
      const toolParsed = parseUniversalToolCalls(choice.message.content, declaredNames);
      if (toolParsed.hasToolCalls) {
        choice.message.tool_calls = toolParsed.toolCalls;
        choice.message.content = toolParsed.text || null;
        if (choice.finish_reason !== "length" && choice.finish_reason !== "content_filter") {
          choice.finish_reason = "tool_calls";
        }
      } else if (toolParsed.text !== choice.message.content) {
        choice.message.content = toolParsed.text || null;
      }
    }

    if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
      const choice = parsed.choices?.[0] || {};
      const message = choice.message || {};
      const output = [];
      const incompleteReason = choice.finish_reason === "length" ? "max_output_tokens"
        : (choice.finish_reason === "content_filter" ? "content_filter" : null);
      const itemStatus = incompleteReason ? "incomplete" : "completed";
      const responseId = String(parsed.id || `resp_${Date.now()}`).replace(/^chatcmpl-/, "resp_");
      if (message.reasoning_content) {
        output.push({ id: `rs_${responseId}`, type: "reasoning", summary: [{ type: "summary_text", text: message.reasoning_content }] });
      }
      if (message.content) {
        output.push({ id: `msg_${responseId}`, type: "message", role: "assistant", status: itemStatus,
          content: [{ type: "output_text", text: message.content, annotations: [] }] });
      }
      for (const [index, call] of (message.tool_calls || []).entries()) {
        const callId = call.id || `call_${responseId}_${index}`;
        output.push({ id: `fc_${callId}`, type: "function_call", call_id: callId,
          name: call.function?.name || "", arguments: call.function?.arguments || "{}", status: itemStatus });
      }
      const responsesBody = {
        id: responseId, object: "response", created_at: parsed.created, model: parsed.model,
        status: incompleteReason ? "incomplete" : "completed", output, error: null,
        incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
        usage: {
          input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0,
          total_tokens: usage.total_tokens ?? (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
          ...(usage.prompt_tokens_details && { input_tokens_details: structuredClone(usage.prompt_tokens_details) }),
          ...(usage.completion_tokens_details && { output_tokens_details: structuredClone(usage.completion_tokens_details) }),
          ...(usage.estimated !== undefined && { estimated: usage.estimated }),
        },
      };
      return await finishSuccess(responsesBody, rawProviderResponse, usage, summary);
    }

    if (sourceFormat === FORMATS.CLAUDE) {
      const choice = parsed?.choices?.[0] || {};
      if (choice.finish_reason === "content_filter") {
        return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Upstream response blocked by content filter");
      }
      const msg = choice.message || {};
      const content = [];
      // Foreign reasoning is unsigned and must remain replayable as text.
      if (msg.reasoning_content) content.push({ type: "text", text: msg.reasoning_content });
      if (msg.content) {
        content.push({ type: "text", text: msg.content });
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const parsedArgs = parseExecutableToolArguments(tc.function?.arguments, choice.finish_reason === "length");
          if (parsedArgs === null) continue;
          content.push({
            type: "tool_use",
            id: tc.id || `toolu_${Date.now()}`,
            name: tc.function?.name || "",
            input: parsedArgs
          });
        }
      }
      if (content.length === 0) {
        content.push({ type: "text", text: "" });
      }
      const claudeResp = {
        id: String(parsed.id || `msg_${Date.now()}`).replace(/^chatcmpl-/, ""),
        type: "message",
        role: "assistant",
        model: parsed.model || model,
        content,
        stop_reason: choice.finish_reason === "length" ? "max_tokens" : (choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn"),
        stop_sequence: null,
        usage: {
          input_tokens: Math.max(0, (usage.prompt_tokens || usage.input_tokens || 0) - (usage.prompt_tokens_details?.cached_tokens || 0)),
          output_tokens: usage.completion_tokens || usage.output_tokens || 0,
          ...(usage.prompt_tokens_details?.cached_tokens !== undefined && { cache_read_input_tokens: usage.prompt_tokens_details.cached_tokens }),
          ...(usage.estimated !== undefined && { estimated: usage.estimated }),
        }
      };
      return await finishSuccess(claudeResp, rawProviderResponse, usage, summary);
    }

    if (!parsed.usage) {
      parsed.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    }

    return await finishSuccess(parsed, rawProviderResponse, usage, summary);
  } catch (err) {
    if (isClientAbort(err)) return createErrorResult(499, "Request aborted");
    console.error("[ChatCore] Chat Completions SSE→JSON failed:", err);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Failed to convert streaming response to JSON");
  }
}
