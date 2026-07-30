import { describe, it, expect } from "vitest";
import { shouldInjectUniversalToolPrompt, injectUniversalToolPrompt, stripPrivateToolFields } from "../../open-sse/translator/concerns/universalToolPrompt.js";
import { adaptHistoryForUniversalTools } from "../../open-sse/translator/concerns/historyAdapter.js";
import { parseUniversalToolCalls } from "../../open-sse/translator/concerns/universalToolParser.js";
import { repairAndParseJson } from "../../open-sse/translator/concerns/jsonAutoRepair.js";
import { createStreamToolShimTransformStream } from "../../open-sse/transformer/streamToolShim.js";
import { stripContextSuffix, parseModel } from "../../open-sse/services/model.js";
import { handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";

describe("Universal Tool Call & MCP Engine", () => {
  it("shouldInjectUniversalToolPrompt detects non-tool models or denylisted models", () => {
    const body = {
      tools: [{ function: { name: "run_command" } }]
    };

    // Native model (Claude 3.5 Sonnet) should NOT inject
    const nativeRes = shouldInjectUniversalToolPrompt(body, { model: "claude-3-5-sonnet", provider: "anthropic", capabilities: { tools: true } });
    expect(nativeRes).toBe(false);

    // Ollama / open model should inject
    const openRes = shouldInjectUniversalToolPrompt(body, { model: "qwen2.5", provider: "ollama", capabilities: { tools: true } });
    expect(openRes).toBe(true);

    // Model with explicit capabilities.tools === false should inject
    const noToolRes = shouldInjectUniversalToolPrompt(body, { model: "custom-model", provider: "custom", capabilities: { tools: false } });
    expect(noToolRes).toBe(true);

    // DeepSeek R1 Distill model should inject
    const r1DistillRes = shouldInjectUniversalToolPrompt(body, { model: "deepseek-r1-distill-qwen-32b", provider: "openrouter", capabilities: { tools: true } });
    expect(r1DistillRes).toBe(true);
  });

  it("injectUniversalToolPrompt escapes XML characters, supports top-level body.system, and strips native tools parameter", () => {
    const body = {
      system: "You are a helpful assistant",
      tools: [
        {
          function: {
            name: "run<script>",
            description: "Run & test <evil>",
            parameters: { type: "object", properties: { cmd: { type: "string" } } }
          }
        }
      ],
      messages: [{ role: "user", content: "Hello" }]
    };

    injectUniversalToolPrompt(body);

    expect(body.system).toContain("You are a helpful assistant");
    expect(body.system).toContain("&lt;script&gt;");
    expect(body.system).toContain("Run &amp; test &lt;evil&gt;");

    // Native tools parameter must be stripped from body
    expect(body.tools).toBeUndefined();
    expect(body._universalToolPromptInjected).toBe(true);
  });

  it("stripPrivateToolFields removes internal metadata fields before upstream dispatch", () => {
    const body = {
      model: "test",
      _universalToolPromptInjected: true,
      _declaredTools: [{ name: "foo" }]
    };

    stripPrivateToolFields(body);

    expect(body._universalToolPromptInjected).toBeUndefined();
    expect(body._declaredTools).toBeUndefined();
    expect(body.model).toBe("test");
  });

  it("adaptHistoryForUniversalTools translates role:tool and Anthropic tool_use to taught prose", () => {
    const body = {
      messages: [
        { role: "assistant", tool_calls: [{ id: "call_1", function: { name: "run_command", arguments: '{"CommandLine":"ls"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "file1.txt\nfile2.txt" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_2", name: "read_file", input: { path: "a.txt" } }] }
      ]
    };

    adaptHistoryForUniversalTools(body);

    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain("Tool Output [run_command]:\nfile1.txt\nfile2.txt");
    expect(body.messages[2].content).toContain('<tool_call>');
    expect(body.messages[2].content).toContain('read_file');
  });

  it("repairAndParseJson auto-fixes trailing commas and single quotes", () => {
    const malformed1 = `{"name": "run_command", "arguments": {"CommandLine": "ls",},}`;
    const parsed1 = repairAndParseJson(malformed1);
    expect(parsed1).toEqual({ name: "run_command", arguments: { CommandLine: "ls" } });

    const malformed2 = `{'name': 'run_command'}`;
    const parsed2 = repairAndParseJson(malformed2);
    expect(parsed2).toEqual({ name: "run_command" });
  });

  it("parseUniversalToolCalls parses XML <tool_call> tags and strips un-declared or malformed tool XML tags", () => {
    const declaredNames = new Set(["run_command"]);
    const rawText = `Here is the command execution:\n<tool_call>\n{"name": "run_command", "arguments": {"CommandLine": "git status"}}\n</tool_call>`;

    const result = parseUniversalToolCalls(rawText, declaredNames);
    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0].function.name).toBe("run_command");
    expect(result.toolCalls[0].function.arguments).toContain("git status");

    // Strict Schema Name Matching: reject un-declared tool names and strip tag from text
    const falseText = `<tool_call>\n{"name": "malicious_tool", "arguments": {}}\n</tool_call>`;
    const falseResult = parseUniversalToolCalls(falseText, declaredNames);
    expect(falseResult.hasToolCalls).toBe(false);
    expect(falseResult.text).not.toContain("<tool_call>");

    // Malformed JSON inside <tool_call> tag should also be stripped
    const malformedText = `<tool_call>\n{invalid json}\n</tool_call>`;
    const malformedResult = parseUniversalToolCalls(malformedText, declaredNames);
    expect(malformedResult.hasToolCalls).toBe(false);
    expect(malformedResult.text).not.toContain("<tool_call>");
  });

  it("stripContextSuffix and parseModel remove [1m]/[128k] suffixes cleanly", () => {
    expect(stripContextSuffix("oc/deepseek-v4-flash-free[1m]")).toBe("oc/deepseek-v4-flash-free");
    expect(stripContextSuffix("claude-sonnet-4[128k]")).toBe("claude-sonnet-4");

    const parsed = parseModel("oc/deepseek-v4-flash-free[1m]");
    expect(parsed.provider).toBe("opencode");
    expect(parsed.model).toBe("deepseek-v4-flash-free");
  });

  it("createStreamToolShimTransformStream drains buffer on flush and supports Claude SSE format", async () => {
    const shim = createStreamToolShimTransformStream([{ name: "test_tool" }], "claude");
    const writer = shim.writable.getWriter();
    const readPromise = new Response(shim.readable).text();

    await writer.write(new TextEncoder().encode(`event: message_start\ndata: {"type":"message_start"}\n\n`));
    await writer.write(new TextEncoder().encode(`data: {"content":"Hello <tool_call>{\\"name\\":\\"test_tool\\",\\"arguments\\":{}}</tool_call>"}`));
    await writer.close();

    const outputText = await readPromise;
    expect(outputText).toContain("message_start");
    expect(outputText).toContain("content_block_start");
    expect(outputText).toContain("test_tool");
    expect(outputText).toContain("message_stop");
  });

  it("createStreamToolShimTransformStream handles partial <tool_call> tag split across SSE chunks", async () => {
    const shim = createStreamToolShimTransformStream([{ name: "split_tool" }], "openai");
    const writer = shim.writable.getWriter();
    const readPromise = new Response(shim.readable).text();

    await writer.write(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"Hi <to"}}]}\n\n`));
    await writer.write(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"ol_call>{\\"name\\":\\"split_tool\\",\\"arguments\\":{}}</tool_call>"}}]}\n\n`));
    await writer.close();

    const outputText = await readPromise;
    expect(outputText).toContain("split_tool");
    expect(outputText).toContain("tool_calls");
  });

  it("createStreamToolShimTransformStream deduplicates content_block_stop for multi-tool Claude streams", async () => {
    const shim = createStreamToolShimTransformStream([{ name: "toolA" }, { name: "toolB" }], "claude");
    const writer = shim.writable.getWriter();
    const readPromise = new Response(shim.readable).text();

    const multiToolXml = `<tool_call>\n{"name":"toolA","arguments":{}}\n</tool_call>\n<tool_call>\n{"name":"toolB","arguments":{}}\n</tool_call>`;
    await writer.write(new TextEncoder().encode(`data: {"content":${JSON.stringify(multiToolXml)}}`));
    await writer.close();

    const outputText = await readPromise;
    // content_block_stop for index 0 text block must appear ONCE
    const stopMatches = outputText.match(/"type":"content_block_stop","index":0/g) || [];
    expect(stopMatches.length).toBe(1);
    expect(outputText).toContain("toolA");
    expect(outputText).toContain("toolB");

    // message_delta with stop_reason: tool_use must appear ONCE
    const deltaMatches = outputText.match(/"stop_reason":"tool_use"/g) || [];
    expect(deltaMatches.length).toBe(1);
  });

  it("createStreamToolShimTransformStream emits terminal events once at stream end for sequential multi-tool chunks", async () => {
    const shim = createStreamToolShimTransformStream([{ name: "toolA" }, { name: "toolB" }], "openai");
    const writer = shim.writable.getWriter();
    const readPromise = new Response(shim.readable).text();

    // Chunk 1: toolA
    await writer.write(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"<tool_call>{\\"name\\":\\"toolA\\",\\"arguments\\":{}}</tool_call>"}}]}\n\n`));
    // Chunk 2: toolB
    await writer.write(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"<tool_call>{\\"name\\":\\"toolB\\",\\"arguments\\":{}}</tool_call>"}}]}\n\n`));
    await writer.close();

    const outputText = await readPromise;
    expect(outputText).toContain("toolA");
    expect(outputText).toContain("toolB");
    
    // finish_reason: tool_calls must appear ONCE at stream completion
    const finishMatches = outputText.match(/"finish_reason":"tool_calls"/g) || [];
    expect(finishMatches.length).toBe(1);
  });

  it("createStreamToolShimTransformStream preserves residual partial toolB tag when toolA finishes in chunk 1", async () => {
    const shim = createStreamToolShimTransformStream([{ name: "toolA" }, { name: "toolB" }], "openai");
    const writer = shim.writable.getWriter();
    const readPromise = new Response(shim.readable).text();

    // Chunk 1: complete toolA + partial toolB tag
    await writer.write(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"<tool_call>{\\"name\\":\\"toolA\\",\\"arguments\\":{}}</tool_call><tool_call>{\\"name\\":\\"too"}}]}\n\n`));
    // Chunk 2: remainder of toolB
    await writer.write(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"lB\\",\\"arguments\\":{}}</tool_call>"}}]}\n\n`));
    await writer.close();

    const outputText = await readPromise;
    expect(outputText).toContain("toolA");
    expect(outputText).toContain("toolB");
  });

  it("createStreamToolShimTransformStream suppresses upstream finish_reason:stop and emits tool_calls BEFORE data: [DONE]", async () => {
    const shim = createStreamToolShimTransformStream([{ name: "test_tool" }], "openai");
    const writer = shim.writable.getWriter();
    const readPromise = new Response(shim.readable).text();

    await writer.write(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"<tool_call>{\\"name\\":\\"test_tool\\",\\"arguments\\":{}}</tool_call>"}}]}\n\n`));
    await writer.write(new TextEncoder().encode(`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`));
    await writer.write(new TextEncoder().encode(`data: [DONE]\n\n`));
    await writer.close();

    const outputText = await readPromise;
    expect(outputText).not.toContain('"finish_reason":"stop"');

    const toolCallIdx = outputText.indexOf('"finish_reason":"tool_calls"');
    const doneIdx = outputText.indexOf('data: [DONE]');
    expect(toolCallIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(-1);
    expect(toolCallIdx).toBeLessThan(doneIdx);
  });

  it("createStreamToolShimTransformStream strips un-declared tool call tags from stream output", async () => {
    const shim = createStreamToolShimTransformStream([{ name: "declared_tool" }], "openai");
    const writer = shim.writable.getWriter();
    const readPromise = new Response(shim.readable).text();

    await writer.write(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"<tool_call>{\\"name\\":\\"undeclared_tool\\",\\"arguments\\":{}}</tool_call>"}}]}\n\n`));
    await writer.close();

    const outputText = await readPromise;
    expect(outputText).not.toContain("<tool_call>");
    expect(outputText).not.toContain("undeclared_tool");
  });

  it("handleNonStreamingResponse strips undeclared tool call tags in Claude non-streaming responses", async () => {
    const claudeResp = {
      type: "message",
      content: [{ type: "text", text: "Hello <tool_call>{\"name\":\"evil\"}</tool_call> world" }],
      stop_reason: "end_turn"
    };

    const mockReqConfig = {
      body: { _universalToolPromptInjected: true, _declaredTools: [{ name: "valid_tool" }] },
      sourceFormat: "claude",
      targetFormat: "claude",
      executor: {},
      providerResponse: { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => claudeResp },
      reqLogger: { logProviderResponse: () => {}, logConvertedResponse: () => {} },
      trackDone: () => {},
      appendLog: () => {}
    };

    const res = await handleNonStreamingResponse(mockReqConfig);
    const bodyJson = await res.response.json();
    expect(bodyJson.content[0].text).not.toContain("<tool_call>");
    expect(bodyJson.content[0].text).toContain("Hello  world");
  });

  it("createStreamToolShimTransformStream emits terminal event if stream ends inside un-closed tool tag", async () => {
    const shim = createStreamToolShimTransformStream([{ name: "toolA" }], "openai");
    const writer = shim.writable.getWriter();
    const readPromise = new Response(shim.readable).text();

    // Stream ends mid-tag without closing </tool_call>
    await writer.write(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"<tool_call>{\\"name\\":\\"toolA\\""}}]}\n\n`));
    await writer.close();

    const outputText = await readPromise;
    expect(outputText).toContain("data: [DONE]");
    expect(outputText).toContain("<tool_call>");
  });
});
