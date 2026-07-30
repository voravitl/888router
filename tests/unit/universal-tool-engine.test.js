import { describe, it, expect } from "vitest";
import { shouldInjectUniversalToolPrompt, injectUniversalToolPrompt } from "../../open-sse/translator/concerns/universalToolPrompt.js";
import { adaptHistoryForUniversalTools } from "../../open-sse/translator/concerns/historyAdapter.js";
import { parseUniversalToolCalls } from "../../open-sse/translator/concerns/universalToolParser.js";
import { repairAndParseJson } from "../../open-sse/translator/concerns/jsonAutoRepair.js";

describe("Universal Tool Call & MCP Engine", () => {
  it("shouldInjectUniversalToolPrompt detects non-tool models or denylisted models", () => {
    const body = {
      tools: [{ function: { name: "run_command" } }]
    };

    // Native model (Claude 3.5 Sonnet) should NOT inject (bypassed)
    const nativeRes = shouldInjectUniversalToolPrompt(body, { model: "claude-3-5-sonnet", provider: "anthropic", capabilities: { tools: true } });
    expect(nativeRes).toBe(false);

    // Ollama / open model should inject
    const openRes = shouldInjectUniversalToolPrompt(body, { model: "ollama/qwen-base", provider: "ollama", capabilities: { tools: false } });
    expect(openRes).toBe(true);
  });

  it("injectUniversalToolPrompt generates compact XML preamble", () => {
    const body = {
      tools: [
        {
          function: {
            name: "run_command",
            description: "Run shell command",
            parameters: { type: "object", properties: { CommandLine: { type: "string" } } }
          }
        }
      ],
      messages: [{ role: "user", content: "Hello" }]
    };

    injectUniversalToolPrompt(body);

    const sysMsg = body.messages.find(m => m.role === "system");
    expect(sysMsg).toBeDefined();
    expect(sysMsg.content).toContain("<available_tools>");
    expect(sysMsg.content).toContain("<name>run_command</name>");
    expect(sysMsg.content).toContain("<tool_call>");
  });

  it("adaptHistoryForUniversalTools translates role:tool to taught prose", () => {
    const body = {
      messages: [
        { role: "assistant", tool_calls: [{ id: "call_1", function: { name: "run_command", arguments: '{"CommandLine":"ls"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "file1.txt\nfile2.txt" }
      ]
    };

    adaptHistoryForUniversalTools(body);

    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain("Tool Output [run_command]:\nfile1.txt\nfile2.txt");
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
});
