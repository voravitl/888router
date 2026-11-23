import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { initState } = await import("open-sse/translator/index.js");
const { FORMATS } = await import("open-sse/translator/formats.js");
const { CLAUDE_STOP, OPENAI_FINISH } = await import("open-sse/translator/schema/finishReasons.js");
const { toOpenAIFinish, fromOpenAIFinish } = await import("open-sse/translator/concerns/finishReason.js");
const { toOpenAIUsage } = await import("open-sse/translator/concerns/usage.js");
const { claudeToOpenAIResponse } = await import("open-sse/translator/response/claude-to-openai.js");
const { openaiToClaudeRequest } = await import("open-sse/translator/request/openai-to-claude.js");
const { translateNonStreamingResponse } = await import("open-sse/handlers/chatCore/nonStreamingHandler.js");

function collectChunks(events) {
  const state = initState(FORMATS.OPENAI);
  const chunks = [];
  for (const ev of events) {
    const out = claudeToOpenAIResponse(ev, state);
    if (Array.isArray(out)) chunks.push(...out);
    else if (out) chunks.push(out);
  }
  return { chunks, state };
}

describe("Claude Fable omitted thinking & refusal fixes", () => {
  it("(a) claudeToOpenAIResponse on omitted thinking emits zero <think>/</think> in delta.content", () => {
    const events = [
      { type: "message_start", message: { id: "msg_fable_1", model: "claude-fable-5-2", usage: { input_tokens: 120, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "EqQBCgIYAh..." } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_01", name: "bash" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 150, output_tokens_details: { thinking_tokens: 110 } },
      },
      { type: "message_stop" },
    ];

    const { chunks, state } = collectChunks(events);
    expect(state.sawThinking).toBe(true);

    const contentDeltas = chunks
      .map((c) => c.choices?.[0]?.delta?.content)
      .filter((v) => v !== undefined);
    expect(contentDeltas).toEqual([]);

    const reasoningDeltas = chunks
      .map((c) => c.choices?.[0]?.delta?.reasoning_content)
      .filter((v) => v !== undefined);
    expect(reasoningDeltas).toEqual([]);

    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant" });
    const toolChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(toolChunks).toHaveLength(2);
    const finalChunk = chunks[chunks.length - 1];
    expect(finalChunk.choices[0].finish_reason).toBe("tool_calls");
    expect(finalChunk.usage.completion_tokens_details).toEqual({ reasoning_tokens: 110 });
  });

  it("(a.2) claudeToOpenAIResponse on redacted_thinking sets state.sawThinking = true", () => {
    const events = [
      { type: "message_start", message: { id: "msg_redacted", model: "claude-fable-5-2" } },
      { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "encrypted..." } },
      { type: "content_block_stop", index: 0 },
    ];
    const { chunks, state } = collectChunks(events);
    expect(state.sawThinking).toBe(true);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant" });
  });

  it("(b) claudeToOpenAIResponse on plaintext thinking routes thinking only to delta.reasoning_content with zero <think> tags", () => {
    const events = [
      { type: "message_start", message: { id: "msg_think_1", model: "claude-opus-4-6" } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Step 1: analyze" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Final answer" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 20 } },
    ];

    const { chunks } = collectChunks(events);
    const contentDeltas = chunks
      .map((c) => c.choices?.[0]?.delta?.content)
      .filter((v) => v !== undefined);
    expect(contentDeltas).toEqual(["Final answer"]);

    const reasoningDeltas = chunks
      .map((c) => c.choices?.[0]?.delta?.reasoning_content)
      .filter((v) => v !== undefined);
    expect(reasoningDeltas).toEqual(["Step 1: analyze"]);
  });

  it("(c) claudeToOpenAIResponse on stop_reason: refusal emits delta.refusal and finish_reason: content_filter, without duplicating if text was already streamed", () => {
    const refusalEvents = [
      { type: "message_start", message: { id: "msg_refusal_1", model: "claude-fable-5-2", usage: { input_tokens: 45, output_tokens: 0 } } },
      {
        type: "message_delta",
        delta: {
          stop_reason: "refusal",
          stop_details: {
            type: "refusal",
            category: "reasoning_extraction",
            explanation: "Blocked by policy",
          },
        },
        usage: { output_tokens: 0 },
      },
      { type: "message_stop" },
    ];

    const { chunks } = collectChunks(refusalEvents);
    const refusalChunks = chunks.filter((c) => c.choices?.[0]?.delta?.refusal !== undefined);
    expect(refusalChunks).toHaveLength(1);
    expect(refusalChunks[0].choices[0].delta.refusal).toBe("Blocked by policy");

    const finalChunk = chunks[chunks.length - 1];
    expect(finalChunk.choices[0].finish_reason).toBe("content_filter");

    // When text was already streamed before refusal, do NOT emit duplicate delta.refusal
    const partialTextThenRefusal = [
      { type: "message_start", message: { id: "msg_refusal_2", model: "claude-fable-5-2" } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial text before block" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: {
          stop_reason: "refusal",
          stop_details: {
            type: "refusal",
            category: "reasoning_extraction",
            explanation: "Blocked by policy",
          },
        },
        usage: { output_tokens: 5 },
      },
    ];

    const { chunks: partialChunks } = collectChunks(partialTextThenRefusal);
    expect(partialChunks.filter((c) => c.choices?.[0]?.delta?.refusal !== undefined)).toHaveLength(0);
    expect(partialChunks[partialChunks.length - 1].choices[0].finish_reason).toBe("content_filter");
  });

  it("(d) openaiToClaudeRequest strips leading empty <think></think> on assistant messages while preserving mid-sentence tags", () => {
    // 1. Poisoned Turn-1 assistant message with content: "<think></think>" + tool_calls -> only [tool_use]
    const reqToolOnly = openaiToClaudeRequest("claude-fable-5-2", {
      messages: [
        { role: "user", content: "Run ls" },
        {
          role: "assistant",
          content: "<think></think>",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "file1.txt" },
      ],
    }, true);

    const assistantMsg1 = reqToolOnly.messages.find((m) => m.role === "assistant");
    expect(assistantMsg1.content).toEqual([
      {
        type: "tool_use",
        id: "call_1",
        name: "bash",
        input: { command: "ls" },
        cache_control: { type: "ephemeral" },
      },
    ]);

    // 2. Assistant message with array content [{ type: "text", text: " <think> </think> " }] + tool_calls -> only [tool_use]
    const reqArrayToolOnly = openaiToClaudeRequest("claude-fable-5-2", {
      messages: [
        { role: "user", content: "Run pwd" },
        {
          role: "assistant",
          content: [{ type: "text", text: "  <think>\n</think>  " }],
          tool_calls: [
            { id: "call_2", type: "function", function: { name: "bash", arguments: '{"command":"pwd"}' } },
          ],
        },
      ],
    }, true);
    const assistantMsgArr = reqArrayToolOnly.messages.find((m) => m.role === "assistant");
    expect(assistantMsgArr.content).toHaveLength(1);
    expect(assistantMsgArr.content[0].type).toBe("tool_use");

    // 3. Leading "<think></think>Hello" -> [{ type: "text", text: "Hello" }]
    const reqLeadingText = openaiToClaudeRequest("claude-fable-5-2", {
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "<think></think>Hello" },
      ],
    }, true);
    const assistantMsg2 = reqLeadingText.messages.find((m) => m.role === "assistant");
    expect(assistantMsg2.content).toEqual([
      { type: "text", text: "Hello", cache_control: { type: "ephemeral" } },
    ]);

    // 4. Mid-sentence "The tag <think></think> broke it" preserved verbatim
    const reqMidSentence = openaiToClaudeRequest("claude-fable-5-2", {
      messages: [
        { role: "user", content: "What happened?" },
        { role: "assistant", content: "The tag <think></think> broke it" },
      ],
    }, true);
    const assistantMsg3 = reqMidSentence.messages.find((m) => m.role === "assistant");
    expect(assistantMsg3.content).toEqual([
      { type: "text", text: "The tag <think></think> broke it", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("(e) translateNonStreamingResponse maps Claude stop_reason: refusal + stop_details.explanation and thinking_tokens", () => {
    const claudeRefusalBody = {
      id: "msg_nonstream_refusal",
      type: "message",
      role: "assistant",
      model: "claude-fable-5-2",
      content: [],
      stop_reason: "refusal",
      stop_details: {
        type: "refusal",
        category: "reasoning_extraction",
        explanation: "Cannot extract hidden chain-of-thought.",
      },
      usage: {
        input_tokens: 50,
        output_tokens: 12,
        output_tokens_details: {
          thinking_tokens: 12,
        },
      },
    };

    const openAIResp = translateNonStreamingResponse(claudeRefusalBody, FORMATS.CLAUDE, FORMATS.OPENAI);
    expect(openAIResp.choices[0].finish_reason).toBe("content_filter");
    expect(openAIResp.choices[0].message.refusal).toBe("Cannot extract hidden chain-of-thought.");
    expect(openAIResp.choices[0].message.content).toBe("");
    expect(openAIResp.usage.completion_tokens_details).toEqual({ reasoning_tokens: 12 });
  });

  it("(f) toOpenAIUsage & finishReason map Claude thinking_tokens and refusal <-> content_filter", () => {
    expect(CLAUDE_STOP.REFUSAL).toBe("refusal");
    expect(toOpenAIFinish("refusal", "claude")).toBe(OPENAI_FINISH.CONTENT_FILTER);
    expect(fromOpenAIFinish("content_filter", "claude")).toBe(CLAUDE_STOP.REFUSAL);

    const usageWithThinking = toOpenAIUsage({
      input_tokens: 100,
      output_tokens: 80,
      output_tokens_details: { thinking_tokens: 60 },
    }, "claude");
    expect(usageWithThinking).toEqual({
      prompt_tokens: 100,
      completion_tokens: 80,
      total_tokens: 180,
      completion_tokens_details: { reasoning_tokens: 60 },
    });

    const usageZeroThinking = toOpenAIUsage({
      input_tokens: 100,
      output_tokens: 20,
      output_tokens_details: { thinking_tokens: 0 },
    }, "claude");
    expect(usageZeroThinking).toEqual({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
    });
    expect(usageZeroThinking.completion_tokens_details).toBeUndefined();
  });
});
