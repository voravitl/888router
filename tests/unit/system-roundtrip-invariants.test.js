import { describe, it, expect } from "vitest";
import "../translator/registerAll.js";
import { translateRequest, translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { createComboStreamGuard } from "../../open-sse/services/comboStreamGuard.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";

const enc = (s) => new TextEncoder().encode(s);

function collectOpenAIStream(targetFormat, events) {
  const state = initState(FORMATS.OPENAI);
  const chunks = [];
  for (const ev of events) {
    const out = translateResponse(targetFormat, FORMATS.OPENAI, ev, state);
    if (Array.isArray(out)) chunks.push(...out);
    else if (out) chunks.push(out);
  }
  return { chunks, state };
}

function accumulateOpenAIAssistant(chunks) {
  let content = "";
  let reasoning = "";
  let refusal = "";
  let finishReason = null;
  const toolCallsByIdx = new Map();

  for (const c of chunks) {
    const choice = c?.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const d = choice.delta || {};
    if (typeof d.content === "string") content += d.content;
    if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
    if (typeof d.refusal === "string") refusal += d.refusal;
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallsByIdx.has(idx)) {
          toolCallsByIdx.set(idx, {
            id: tc.id || `call_${idx}`,
            type: "function",
            function: { name: tc.function?.name || "", arguments: "" },
          });
        }
        const entry = toolCallsByIdx.get(idx);
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.function.name = tc.function.name;
        if (typeof tc.function?.arguments === "string") entry.function.arguments += tc.function.arguments;
      }
    }
  }

  return {
    content,
    reasoning,
    refusal,
    finishReason,
    tool_calls: [...toolCallsByIdx.values()],
  };
}

describe("System Invariant 1: Zero <think></think> leakage into OpenAI delta.content", () => {
  const providerFixtures = [
    {
      name: "Claude (omitted thinking + tool_use)",
      format: FORMATS.CLAUDE,
      events: [
        { type: "message_start", message: { id: "msg_1", model: "claude-fable-5-2", usage: { input_tokens: 100, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "EqoBCkYIARgC" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_01", name: "shell" } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
        { type: "message_stop" },
      ],
    },
    {
      name: "Claude (plaintext thinking + text)",
      format: FORMATS.CLAUDE,
      events: [
        { type: "message_start", message: { id: "msg_2", model: "claude-opus-5-5" } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "step 1" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "done" } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } },
        { type: "message_stop" },
      ],
    },
    {
      name: "Gemini (thought + text + functionCall)",
      format: FORMATS.GEMINI,
      events: [
        { candidates: [{ content: { parts: [{ text: "internal plan", thought: true }] } }], responseId: "r1", modelVersion: "gemini-4-neon" },
        { candidates: [{ content: { parts: [{ text: "answer" }, { functionCall: { name: "shell", args: { command: "ls" } } }] } }] },
        { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3, totalTokenCount: 18 } },
      ],
    },
    {
      name: "Kiro (reasoning + text + toolUse)",
      format: FORMATS.KIRO,
      events: [
        { reasoningContentEvent: { text: "plan" }, _eventType: "reasoningContentEvent" },
        { assistantResponseEvent: { content: "ok" }, _eventType: "assistantResponseEvent" },
        { toolUseEvent: { toolUseId: "tu_1", name: "shell", input: { command: "ls" } }, _eventType: "toolUseEvent" },
        { _eventType: "messageStopEvent" },
      ],
    },
    {
      name: "Ollama (thinking + content)",
      format: FORMATS.OLLAMA,
      events: [
        { model: "qwen3", message: { role: "assistant", content: "ok", thinking: "plan" } },
        { model: "qwen3", done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 4 },
      ],
    },
    {
      name: "OpenAI-Responses (reasoning summary + text)",
      format: FORMATS.OPENAI_RESPONSES,
      events: [
        { type: "response.reasoning_summary_text.delta", delta: "plan" },
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 4 } } },
      ],
    },
  ];

  for (const fx of providerFixtures) {
    it(`${fx.name} never leaks <think> or </think> into delta.content`, () => {
      const { chunks } = collectOpenAIStream(fx.format, fx.events);
      const acc = accumulateOpenAIAssistant(chunks);
      expect(acc.content).not.toMatch(/<\/?think>/i);
    });
  }
});

describe("System Invariant 2: Multi-Turn Tool-Call Round-Trip (Turn 1 response -> Turn 2 request)", () => {
  const claudeModels = ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

  for (const model of claudeModels) {
    it(`Claude ${model} Turn 1 omitted-thinking + tool_use round-trips cleanly into Turn 2`, () => {
      const { chunks } = collectOpenAIStream(FORMATS.CLAUDE, [
        { type: "message_start", message: { id: "msg_rt", model, usage: { input_tokens: 50, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "EqoBCkYIARgC" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_rt_1", name: "shell" } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
        { type: "message_stop" },
      ]);
      const turn1 = accumulateOpenAIAssistant(chunks);
      expect(turn1.finishReason).toBe("tool_calls");
      expect(turn1.content).toBe("");
      expect(turn1.tool_calls).toHaveLength(1);

      const turn2OpenAI = {
        model,
        stream: true,
        reasoning_effort: "medium",
        tools: [{
          type: "function",
          function: {
            name: "shell",
            description: "run cmd",
            parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
          },
        }],
        messages: [
          { role: "user", content: "list files" },
          { role: "assistant", content: turn1.content || null, tool_calls: turn1.tool_calls },
          { role: "tool", tool_call_id: turn1.tool_calls[0].id, content: "README.md\npackage.json\n" },
        ],
      };

      const translated = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, model, turn2OpenAI, true, null, "anthropic");
      const prepared = prepareClaudeRequest(translated, "anthropic");

      const assistantMsg = prepared.messages.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg.content.some((b) => b.type === "text" && /<think>/i.test(b.text))).toBe(false);
      expect(assistantMsg.content.some((b) => b.type === "tool_use" && b.id === "toolu_rt_1")).toBe(true);

      const assistantIdx = prepared.messages.indexOf(assistantMsg);
      const nextMsg = prepared.messages[assistantIdx + 1];
      expect(nextMsg?.role).toBe("user");
      expect(nextMsg?.content.some((b) => b.type === "tool_result" && b.tool_use_id === "toolu_rt_1")).toBe(true);

      expect(prepared.thinking?.type).not.toBe("enabled");
      if (model === "claude-fable-5-2") {
        expect(prepared.thinking).toBeUndefined();
      }
      expect(prepared.output_config?.effort).toBe("medium");
    });
  }

  it("Gemini gemini-4-neon Turn 1 thought + functionCall round-trips cleanly into Turn 2", () => {
    const { chunks } = collectOpenAIStream(FORMATS.GEMINI, [
      {
        candidates: [{ content: { parts: [{ text: "thinking...", thought: true }, { functionCall: { name: "shell", args: { command: "ls" } } }] } }],
        responseId: "gem_rt_1",
        modelVersion: "gemini-4-neon",
      },
      {
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 3, totalTokenCount: 28 },
      },
    ]);
    const turn1 = accumulateOpenAIAssistant(chunks);
    expect(turn1.finishReason).toBe("tool_calls");
    expect(turn1.content).toBe("");
    expect(turn1.tool_calls).toHaveLength(1);

    const turn2OpenAI = {
      model: "gemini-4-neon",
      stream: true,
      reasoning_effort: "medium",
      tools: [{
        type: "function",
        function: {
          name: "shell",
          description: "run cmd",
          parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        },
      }],
      messages: [
        { role: "user", content: "list files" },
        { role: "assistant", content: turn1.content || null, reasoning_content: turn1.reasoning || undefined, tool_calls: turn1.tool_calls },
        { role: "tool", tool_call_id: turn1.tool_calls[0].id, content: "README.md\n" },
      ],
    };

    const translated = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, "gemini-4-neon", turn2OpenAI, true, null, "antigravity");
    const contents = translated.contents || translated.request?.contents || [];
    const modelMsg = contents.find((c) => c.role === "model");
    const fnPart = modelMsg?.parts?.find((p) => p.functionCall);
    expect(fnPart?.functionCall?.name).toBe("shell");
    expect(typeof fnPart?.thoughtSignature).toBe("string");
    const userToolRespMsg = contents.find((c) => c.role === "user" && c.parts?.some((p) => p.functionResponse));
    expect(userToolRespMsg).toBeDefined();
  });

  it("OpenAI-Responses (Codex) Turn 1 function_call round-trips cleanly into Turn 2", () => {
    const { chunks } = collectOpenAIStream(FORMATS.OPENAI_RESPONSES, [
      { type: "response.output_item.added", item: { type: "function_call", call_id: "call_cx_1", name: "shell" } },
      { type: "response.function_call_arguments.delta", delta: '{"command":"ls"}' },
      { type: "response.output_item.done", item: { type: "function_call" } },
      { type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 10 } } },
    ]);
    const turn1 = accumulateOpenAIAssistant(chunks);
    expect(turn1.finishReason).toBe("tool_calls");
    expect(turn1.tool_calls).toHaveLength(1);

    const turn2OpenAI = {
      model: "gpt-5.3-codex",
      stream: true,
      tools: [{
        type: "function",
        function: {
          name: "shell",
          description: "run cmd",
          parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        },
      }],
      messages: [
        { role: "user", content: "list files" },
        { role: "assistant", content: null, tool_calls: turn1.tool_calls },
        { role: "tool", tool_call_id: turn1.tool_calls[0].id, content: "README.md\n" },
      ],
    };

    const translated = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "gpt-5.3-codex", turn2OpenAI, true, null, "codex");
    const inputItems = translated.input || [];
    const fcItem = inputItems.find((i) => i.type === "function_call" && i.call_id === "call_cx_1");
    const fcoItem = inputItems.find((i) => i.type === "function_call_output" && i.call_id === "call_cx_1");
    expect(fcItem).toBeDefined();
    expect(fcoItem).toBeDefined();
  });
});

describe("System Invariant 3: Refusals and hidden-thinking exhaustion are never silently swallowed", () => {
  it("Claude streaming refusal -> delta.refusal + finish_reason:content_filter + guard keeps it", () => {
    const { chunks } = collectOpenAIStream(FORMATS.CLAUDE, [
      { type: "message_start", message: { id: "msg_ref", model: "claude-fable-5-2", usage: { input_tokens: 400, output_tokens: 0 } } },
      {
        type: "message_delta",
        delta: {
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "reasoning_extraction", explanation: "Blocked by policy" },
        },
        usage: { output_tokens: 0 },
      },
      { type: "message_stop" },
    ]);

    const acc = accumulateOpenAIAssistant(chunks);
    expect(acc.refusal).toBe("Blocked by policy");
    expect(acc.finishReason).toBe("content_filter");

    const guard = createComboStreamGuard();
    for (const c of chunks) guard.feed(enc(`data: ${JSON.stringify(c)}\n\n`));
    guard.feed(enc("data: [DONE]\n\n"));
    guard.feedEnd();
    expect(guard.isEmpty()).toBe(false);
  });

  it("Claude non-streaming refusal -> message.refusal + finish_reason:content_filter", () => {
    const out = translateNonStreamingResponse({
      id: "msg_ref_ns",
      model: "claude-fable-5-2",
      content: [],
      stop_reason: "refusal",
      stop_details: { type: "refusal", explanation: "Blocked non-stream" },
      usage: { input_tokens: 100, output_tokens: 0 },
    }, FORMATS.CLAUDE, FORMATS.OPENAI);

    expect(out.choices[0].finish_reason).toBe("content_filter");
    expect(out.choices[0].message.refusal).toBe("Blocked non-stream");
  });

  it("Claude omitted-thinking max_tokens exhaustion (no <think> tags) -> guard detects sawReasoning", () => {
    const { chunks } = collectOpenAIStream(FORMATS.CLAUDE, [
      { type: "message_start", message: { id: "msg_exh", model: "claude-fable-5-2", usage: { input_tokens: 100, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "EqoBCkYIARgC" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 256, output_tokens_details: { thinking_tokens: 256 } } },
      { type: "message_stop" },
    ]);

    const guard = createComboStreamGuard();
    for (const c of chunks) guard.feed(enc(`data: ${JSON.stringify(c)}\n\n`));
    guard.feed(enc("data: [DONE]\n\n"));
    guard.feedEnd();
    expect(guard.isEmpty()).toBe(true);
    expect(guard.sawReasoning()).toBe(true);
    expect(guard.finishReason()).toBe("length");
  });
});

describe("System Invariant 4: Registry <-> Capabilities & Claude Thinking Contracts", () => {
  it("every registered model has sane contextWindow & maxOutput bounds", () => {
    const violations = [];
    for (const provider of REGISTRY) {
      for (const m of provider.models || []) {
        const modelId = m.upstreamModelId || m.id;
        const caps = getCapabilitiesForModel(provider.id, modelId);
        if (!Number.isFinite(caps.contextWindow) || caps.contextWindow <= 0) {
          violations.push(`${provider.id}/${modelId}: invalid contextWindow=${caps.contextWindow}`);
        }
        if (!Number.isFinite(caps.maxOutput) || caps.maxOutput <= 0) {
          violations.push(`${provider.id}/${modelId}: invalid maxOutput=${caps.maxOutput}`);
        }
        if (caps.maxOutput > caps.contextWindow) {
          violations.push(`${provider.id}/${modelId}: maxOutput(${caps.maxOutput}) > contextWindow(${caps.contextWindow})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("Claude 5.x / Fable thinkingDisableType & omitThinkingSwitch invariants hold", () => {
    const fableBody = { model: "claude-fable-5-2" };
    applyThinking(FORMATS.CLAUDE, "claude-fable-5-2", fableBody, "anthropic", { mode: "none" });
    expect(fableBody.thinking).toBeUndefined();
    expect(fableBody.output_config?.effort).toBe("low");

    const opusBody = { model: "claude-opus-5-5" };
    applyThinking(FORMATS.CLAUDE, "claude-opus-5-5", opusBody, "anthropic", { mode: "none" });
    expect(opusBody.thinking).toEqual({ type: "adaptive" });
    expect(opusBody.output_config?.effort).toBe("low");

    const sonnetBody = { model: "claude-sonnet-5-5" };
    applyThinking(FORMATS.CLAUDE, "claude-sonnet-5-5", sonnetBody, "anthropic", { mode: "none" });
    expect(sonnetBody.thinking).toEqual({ type: "between_tools" });
  });
});
