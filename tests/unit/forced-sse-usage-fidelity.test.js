import { beforeEach, describe, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => ({ saveRequestDetail: vi.fn(async () => {}) }));
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: persistence.saveRequestDetail,
  saveRequestUsage: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
}));

import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";

const usage = { input_tokens: 500000, output_tokens: 30, total_tokens: 500030,
  input_tokens_details: { cached_tokens: 400000 }, output_tokens_details: { reasoning_tokens: 10 },
  estimated: false, provider_extension: { retained: true } };
const nonce = "tool_nonce_153";
const toolItem = { type: "function_call", id: "fc-real", call_id: "call-real", name: "verify_markers",
  arguments: JSON.stringify({ nonce, text: "ไทย 🌏", start: "start", middle: "middle", end: "end" }) };

function responseStream(output = [toolItem], extraUsage = usage) {
  const events = [
    { type: "response.created", response: { id: "resp-real", created_at: 123, model: "actual-model", status: "in_progress" } },
    ...output.map((item, output_index) => ({ type: "response.output_item.done", item, output_index })),
    { type: "response.completed", response: { id: "resp-real", model: "actual-model", status: "completed", output,
      usage: extraUsage, service_tier: "default" } },
  ];
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13));
    controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
}
function argsFor(providerResponse, sourceFormat = FORMATS.OPENAI, targetFormat = FORMATS.OPENAI_RESPONSES) {
  return { providerResponse, sourceFormat, targetFormat, provider: "codex", model: "requested-alias",
    body: { model: "requested-alias", stream: false }, stream: false, requestStartTime: Date.now(),
    trackDone: vi.fn(), appendLog: vi.fn(), connectionId: "test-account", universalToolsMode: "off" };
}

describe("forced SSE JSON transport and usage fidelity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reconstructs terminal Responses metadata and usage without erasing cache or estimate provenance", async () => {
    const response = await convertResponsesStreamToJson(responseStream().body);
    expect(response.model).toBe("actual-model");
    expect(response.service_tier).toBe("default");
    expect(response.usage).toEqual(usage);
    expect(response.output).toEqual([toolItem]);
    expect(response.status).toBe("completed");
  });

  it("omits provider usage when the Responses stream never reports it", async () => {
    const terminal = { type: "response.completed", response: { id: "resp-no-usage", model: "actual-model",
      output: [toolItem], status: "completed" } };
    const upstream = () => new Response(`data: ${JSON.stringify(terminal)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    const parsed = await convertResponsesStreamToJson(upstream().body);
    expect(parsed).not.toHaveProperty("usage");
    const result = await handleForcedSSEToJson(argsFor(upstream()));
    expect(result.success).toBe(true);
    expect(persistence.saveRequestDetail.mock.calls[0][0].providerResponse).not.toHaveProperty("usage");
    const client = await result.response.json();
    expect(client.usage.prompt_tokens).toBe(0);
    expect(client.usage).not.toHaveProperty("estimated");
    expect(await convertResponsesStreamToJson(null)).not.toHaveProperty("usage");
  });

  it("retains explicitly reported zero usage as provider evidence", async () => {
    const zeroUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    const response = await convertResponsesStreamToJson(responseStream([], zeroUsage).body);
    expect(response.usage).toEqual(zeroUsage);
    expect(response.usage).not.toHaveProperty("estimated");
  });

  it("uses completed output when the provider omits output_item.done events", async () => {
    const terminal = { type: "response.completed", response: { id: "resp-terminal", model: "actual-model",
      output: [toolItem], usage, status: "completed" } };
    const response = await convertResponsesStreamToJson(new Response(`data: ${JSON.stringify(terminal)}\n\n`).body);
    expect(response.output).toEqual([toolItem]);
    expect(response.model).toBe("actual-model");
    expect(response.usage).toEqual(usage);
  });

  it("records raw reconstructed provider usage and tool-only nonce while preserving client cache details", async () => {
    const result = await handleForcedSSEToJson(argsFor(responseStream()));
    const response = await result.response.json();
    expect(result.success).toBe(true);
    expect(response.model).toBe("actual-model");
    expect(response.choices[0].message.tool_calls[0].function.arguments).toBe(toolItem.arguments);
    expect(response.usage.prompt_tokens).toBe(500000);
    expect(response.usage.prompt_tokens_details.cached_tokens).toBe(400000);
    expect(response.usage.completion_tokens_details.reasoning_tokens).toBe(10);
    expect(response.usage.estimated).toBe(false);
    const raw = persistence.saveRequestDetail.mock.calls[0][0].providerResponse;
    expect(raw.usage).toEqual(usage);
    expect(raw.output).toEqual([toolItem]);
    expect(JSON.stringify(raw)).toContain(nonce);
  });

  it.each([FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.ANTIGRAVITY])("keeps tool arguments, model and usage in the correct %s envelope", async (format) => {
    const result = await handleForcedSSEToJson(argsFor(responseStream(), format));
    const json = await result.response.json();
    const response = format === FORMATS.GEMINI ? json : json.response;
    expect(response.candidates[0].content.parts).toEqual([{ functionCall: { name: toolItem.name,
      args: JSON.parse(toolItem.arguments) } }]);
    expect(response.modelVersion).toBe("actual-model");
    expect(response.usageMetadata).toEqual({ promptTokenCount: 500000, candidatesTokenCount: 20,
      totalTokenCount: 500030, cachedContentTokenCount: 400000, thoughtsTokenCount: 10, estimated: false });
    if (format === FORMATS.GEMINI) expect(json.response).toBeUndefined();
  });

  it.each([FORMATS.OPENAI, FORMATS.CLAUDE])("preserves chat reasoning alongside text and usage for %s", async (format) => {
    const chunk = { choices: [{ delta: { content: "answer", reasoning_content: "thinking" }, finish_reason: "length" }],
      usage: { prompt_tokens: 500000, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 400000 }, estimated: true } };
    const result = await handleForcedSSEToJson({ ...argsFor(new Response(`data: ${JSON.stringify(chunk)}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } }), format, FORMATS.OPENAI), provider: "openai" });
    const json = await result.response.json();
    if (format === FORMATS.CLAUDE) {
      expect(json.content).toEqual([{ type: "text", text: "thinking" }, { type: "text", text: "answer" }]);
      expect(json.stop_reason).toBe("max_tokens");
      expect(json.usage).toEqual({ input_tokens: 100000, output_tokens: 30, cache_read_input_tokens: 400000, estimated: true });
    } else {
      expect(json.choices[0].message).toMatchObject({ content: "answer", reasoning_content: "thinking" });
      expect(json.usage.estimated).toBe(true);
    }
  });

  it("preserves Responses reasoning summaries for Claude", async () => {
    const output = [{ type: "reasoning", summary: [{ type: "summary_text", text: "summary one " },
      { type: "summary_text", text: "summary two" }] }, { type: "message", role: "assistant",
      content: [{ type: "output_text", text: "answer part one " }, { type: "output_text", text: "part two" }] }];
    const result = await handleForcedSSEToJson(argsFor(responseStream(output), FORMATS.CLAUDE));
    const json = await result.response.json();
    expect(json.content).toEqual([{ type: "text", text: "summary one summary two" },
      { type: "text", text: "answer part one part two" }]);
    expect(json.content.every((block) => block.type === "text" && typeof block.text === "string")).toBe(true);
    const replay = claudeToOpenAIRequest("actual-model", { max_tokens: 256,
      messages: [{ role: "assistant", content: json.content }, { role: "user", content: "Continue." }] }, false);
    expect(JSON.stringify(replay.messages[0])).toContain("summary one summary two");
    expect(JSON.stringify(replay.messages[0])).toContain("answer part one part two");
    expect(replay.messages[0]).not.toHaveProperty("thinking");
  });

  it.each([FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI])("rejects malformed tool JSON when converting %s transport to Claude", async (target) => {
    const upstream = target === FORMATS.OPENAI_RESPONSES ? responseStream([{ ...toolItem, arguments: "{broken" }])
      : new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-invalid",
        function: { name: "verify", arguments: "{broken" } }] }, finish_reason: "tool_calls" }] })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } });
    const args = { ...argsFor(upstream, FORMATS.CLAUDE, target), onRequestSuccess: vi.fn() };
    const result = await handleForcedSSEToJson(args);
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(args.onRequestSuccess).not.toHaveBeenCalled();
    expect(args.appendLog).not.toHaveBeenCalled();
    expect(persistence.saveRequestDetail).not.toHaveBeenCalled();
  });

  it("preserves Responses cache and estimate provenance for Claude without double counting cached input", async () => {
    const result = await handleForcedSSEToJson(argsFor(responseStream([toolItem], { ...usage, estimated: true }), FORMATS.CLAUDE));
    const json = await result.response.json();
    expect(json.usage).toEqual({ input_tokens: 100000, output_tokens: 30, cache_read_input_tokens: 400000, estimated: true });
    expect(json.content[0].input.nonce).toBe(nonce);
  });

  it("does not label a Responses content-filter stop as Claude max_tokens", async () => {
    const terminal = { type: "response.incomplete", response: { id: "resp-filtered", status: "incomplete", usage,
      incomplete_details: { reason: "content_filter" }, output: [] } };
    const result = await handleForcedSSEToJson(argsFor(new Response(`data: ${JSON.stringify(terminal)}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } }), FORMATS.CLAUDE));
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toContain("content filter");
  });

  it("rejects a chat stream that closes without finish_reason or DONE", async () => {
    const upstream = new Response('data: {"id":"chat-incomplete","choices":[{"delta":{"content":"partial"}}]}\n\n',
      { headers: { "Content-Type": "text/event-stream" } });
    const result = await handleForcedSSEToJson({ ...argsFor(upstream, FORMATS.OPENAI, FORMATS.OPENAI), provider: "openai" });
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
  });

  it.each(["response.failed", "response.created"])("does not report a %s stream as successful", async (type) => {
    const upstream = { type, response: { id: "resp-error", status: type === "response.failed" ? "failed" : "in_progress",
      ...(type === "response.failed" && { error: { message: "provider failed" } }) } };
    const result = await handleForcedSSEToJson(argsFor(new Response(`data: ${JSON.stringify(upstream)}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } }), FORMATS.GEMINI));
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
  });

  it.each([[FORMATS.GEMINI, "MAX_TOKENS"], [FORMATS.OPENAI, "length"], [FORMATS.CLAUDE, "max_tokens"]])(
    "preserves Responses incomplete disposition for %s clients", async (format, expected) => {
      const item = { type: "message", role: "assistant", content: [{ type: "output_text", text: "partial answer" }] };
      const terminal = { type: "response.incomplete", response: { id: "resp-partial", model: "actual-model", status: "incomplete",
        output: [item], usage, incomplete_details: { reason: "max_output_tokens" } } };
      const result = await handleForcedSSEToJson(argsFor(new Response(`data: ${JSON.stringify(terminal)}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } }), format));
      const json = await result.response.json();
      const disposition = format === FORMATS.GEMINI ? json.candidates[0].finishReason
        : (format === FORMATS.CLAUDE ? json.stop_reason : json.choices[0].finish_reason);
      expect(disposition).toBe(expected);
    });

  it.each([[FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES], [FORMATS.GEMINI, FORMATS.OPENAI_RESPONSES],
    [FORMATS.CLAUDE, FORMATS.OPENAI]])("retains incomplete content and omits unparseable executable tools for %s from %s", async (source, target) => {
    const terminal = { type: "response.incomplete", response: { id: "resp-incomplete", model: "actual-model", status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" }, usage,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "partial answer" }] },
        { ...toolItem, arguments: '{"key":' }] } };
    const chat = { choices: [{ delta: { content: "partial answer", tool_calls: [{ index: 0,
      function: { name: toolItem.name, arguments: '{"key":' } }] }, finish_reason: "length" }], usage: { prompt_tokens: 500000 } };
    const upstream = new Response(`data: ${JSON.stringify(target === FORMATS.OPENAI ? chat : terminal)}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } });
    const args = { ...argsFor(upstream, source, target), onRequestSuccess: vi.fn() };
    const result = await handleForcedSSEToJson(args);
    expect(result.success).toBe(true);
    const json = await result.response.json();
    if (source === FORMATS.GEMINI) {
      expect(json.candidates[0].finishReason).toBe("MAX_TOKENS");
      expect(json.candidates[0].content.parts).toEqual([{ text: "partial answer" }]);
    } else {
      expect(json.stop_reason).toBe("max_tokens");
      expect(json.content).toEqual([{ type: "text", text: "partial answer" }]);
    }
    expect(args.onRequestSuccess).toHaveBeenCalledTimes(1);
    expect(persistence.saveRequestDetail.mock.calls[0][0].status).toBe("success");
    expect(JSON.stringify(persistence.saveRequestDetail.mock.calls[0][0].providerResponse)).toContain('key');
  });

  it.each(["length", "content_filter"])("marks Responses message and function items incomplete for %s chat completion", async (finish_reason) => {
    const chat = { choices: [{ delta: { content: "partial answer", tool_calls: [{ index: 0,
      function: { name: toolItem.name, arguments: '{"key":' } }] }, finish_reason }] };
    const result = await handleForcedSSEToJson({ ...argsFor(new Response(`data: ${JSON.stringify(chat)}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } }), FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI), provider: "openai" });
    const json = await result.response.json();
    expect(json.status).toBe("incomplete");
    expect(json.output.map((item) => item.status)).toEqual(["incomplete", "incomplete"]);
  });

  it.each(["length", "content_filter"])("universal tool parsing cannot promote %s to completed", async (finish_reason) => {
    const chat = { choices: [{ delta: { content: '<tool_call>{"name":"verify_markers","arguments":{"key":17}}</tool_call>' }, finish_reason }] };
    const args = { ...argsFor(new Response(`data: ${JSON.stringify(chat)}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } }), FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI), provider: "openai",
      universalToolsMode: "auto", body: { tools: [{ type: "function", function: { name: "verify_markers", parameters: { type: "object" } } }] } };
    const result = await handleForcedSSEToJson(args);
    const json = await result.response.json();
    expect(json.status).toBe("incomplete");
    expect(json.output.find((item) => item.type === "function_call").status).toBe("incomplete");
  });

  it("rejects Responses-only frames even when they contain a DONE sentinel on Chat transport", async () => {
    const upstream = new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\ndata: [DONE]\n\n',
      { headers: { "Content-Type": "text/event-stream" } });
    const result = await handleForcedSSEToJson({ ...argsFor(upstream, FORMATS.OPENAI, FORMATS.OPENAI), provider: "openai" });
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(persistence.saveRequestDetail).not.toHaveBeenCalled();
  });

  it("converts chat tool and reasoning output into Responses JSON with cache details and incomplete disposition", async () => {
    const upstream = { id: "chatcmpl-tools", model: "actual-chat-model", choices: [{ delta: {
      reasoning_content: "Reasoning summary", tool_calls: [{ index: 0, id: "call-real", type: "function",
        function: { name: toolItem.name, arguments: toolItem.arguments } }] }, finish_reason: "length" }],
      usage: { prompt_tokens: 500000, completion_tokens: 30, total_tokens: 500030,
        prompt_tokens_details: { cached_tokens: 400000 }, completion_tokens_details: { reasoning_tokens: 10 }, estimated: true } };
    const result = await handleForcedSSEToJson({ ...argsFor(new Response(`data: ${JSON.stringify(upstream)}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } }), FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI), provider: "openai" });
    const json = await result.response.json();
    expect(json.object).toBe("response");
    expect(json.status).toBe("incomplete");
    expect(json.incomplete_details.reason).toBe("max_output_tokens");
    expect(json.output[0]).toMatchObject({ type: "reasoning", summary: [{ type: "summary_text", text: "Reasoning summary" }] });
    expect(json.output[1]).toMatchObject({ type: "function_call", call_id: "call-real", name: toolItem.name, arguments: toolItem.arguments, status: "incomplete" });
    expect(json.usage).toEqual({ input_tokens: 500000, output_tokens: 30, total_tokens: 500030,
      input_tokens_details: { cached_tokens: 400000 }, output_tokens_details: { reasoning_tokens: 10 }, estimated: true });
    expect(persistence.saveRequestDetail.mock.calls[0][0].providerResponse.usage.estimated).toBe(true);
  });

  it("does not select the Responses parser based on the client source format", async () => {
    const upstream = new Response('data: {"id":"chat-real","model":"actual-chat-model","choices":[{"delta":{"content":"actual chat text"},"finish_reason":"stop"}],"usage":{"prompt_tokens":500000,"completion_tokens":3,"total_tokens":500003}}\n\ndata: [DONE]\n\n',
      { headers: { "Content-Type": "text/event-stream" } });
    const result = await handleForcedSSEToJson({ ...argsFor(upstream, FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI), provider: "openai" });
    const json = await result.response.json();
    expect(result.success).toBe(true);
    expect(json.model).toBe("actual-chat-model");
    expect(json.object).toBe("response");
    expect(json.output[0].content[0].text).toBe("actual chat text");
    expect(json.usage.input_tokens).toBe(500000);
    expect(json.status).toBe("completed");
    expect(persistence.saveRequestDetail.mock.calls[0][0].providerResponse.usage.prompt_tokens).toBe(500000);
  });
});
