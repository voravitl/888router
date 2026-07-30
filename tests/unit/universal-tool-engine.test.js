import { describe, it, expect } from "vitest";
import { shouldInjectUniversalToolPrompt, injectUniversalToolPrompt, stripPrivateToolFields } from "../../open-sse/translator/concerns/universalToolPrompt.js";
import { adaptHistoryForUniversalTools } from "../../open-sse/translator/concerns/historyAdapter.js";
import { parseUniversalToolCalls } from "../../open-sse/translator/concerns/universalToolParser.js";
import { repairAndParseJson } from "../../open-sse/translator/concerns/jsonAutoRepair.js";
import { createStreamToolShimTransformStream } from "../../open-sse/transformer/streamToolShim.js";
import { stripContextSuffix, parseModel } from "../../open-sse/services/model.js";

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
  });

  it("injectUniversalToolPrompt escapes XML characters and strips native tools parameter", () => {
    const body = {
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

    const sysMsg = body.messages.find(m => m.role === "system");
    expect(sysMsg).toBeDefined();
    expect(sysMsg.content).toContain("&lt;script&gt;");
    expect(sysMsg.content).toContain("Run &amp; test &lt;evil&gt;");

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

  it("parseUniversalToolCalls parses XML <tool_call> tags with Strict Schema Name Matching", () => {
    const declaredNames = new Set(["run_command"]);
    const rawText = `Here is the command execution:\n<tool_call>\n{"name": "run_command", "arguments": {"CommandLine": "git status"}}\n</tool_call>`;

    const result = parseUniversalToolCalls(rawText, declaredNames);
    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0].function.name).toBe("run_command");
    expect(result.toolCalls[0].function.arguments).toContain("git status");

    // Strict Schema Name Matching: reject un-declared tool names
    const falseText = `<tool_call>\n{"name": "malicious_tool", "arguments": {}}\n</tool_call>`;
    const falseResult = parseUniversalToolCalls(falseText, declaredNames);
    expect(falseResult.hasToolCalls).toBe(false);
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

    await writer.write(new TextEncoder().encode(`data: {"content":"Hello <tool_call>{\\"name\\":\\"test_tool\\",\\"arguments\\":{}}</tool_call>"}`));
    await writer.close();

    const outputText = await readPromise;
    expect(outputText).toContain("content_block_start");
    expect(outputText).toContain("test_tool");
    expect(outputText).toContain("message_stop");
  });
});
