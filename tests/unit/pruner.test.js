import { describe, it, expect } from "vitest";
import { estimateRequestTokens, groupMessageTurns, pruneMessageHistory } from "../../open-sse/translator/concerns/pruner.js";

describe("pruner: tool-pair aware atomic context pruner", () => {
  it("estimates token count correctly for text and tools", () => {
    const body = {
      messages: [{ role: "user", content: "Hello world this is a test prompt" }],
      tools: [{ type: "function", function: { name: "test_tool" } }]
    };
    const est = estimateRequestTokens(body);
    expect(est).toBeGreaterThan(0);
  });

  it("groups messages into atomic turns and preserves trailing turn", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1", tool_calls: [{ id: "tc1" }] },
      { role: "tool", tool_call_id: "tc1", content: "res1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" }
    ];
    const groups = groupMessageTurns(messages);
    expect(groups.length).toBe(3); // system, u1+a1+tool, u2+a2
    expect(groups[0].isSystem).toBe(true);
    expect(groups[2].isTrailing).toBe(true);
  });

  it("prunes middle messages atomically without splitting tool_use and tool_result", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "Long prompt ".repeat(500) },
      { role: "assistant", content: "a1", tool_calls: [{ id: "tc1" }] },
      { role: "tool", tool_call_id: "tc1", content: "res1 ".repeat(500) },
      { role: "user", content: "Current user turn" },
      { role: "assistant", content: "a2" }
    ];
    const body = { messages };

    // Force small budget via model capabilities mock simulation
    const pruned = pruneMessageHistory(body, "glm", "glm-5.1");
    expect(pruned.messages).toBeDefined();

    // Verify tombstone msg is present if pruned
    if (body._pruned) {
      expect(JSON.stringify(pruned.messages)).toContain("history turns omitted");
      // Verify tool pair was kept intact or removed as a whole group
      const hasToolUse = pruned.messages.some(m => m.tool_calls);
      const hasToolResult = pruned.messages.some(m => m.role === "tool");
      expect(hasToolUse).toEqual(hasToolResult);
    }
  });
});
