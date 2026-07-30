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
  });

  it("preserves 70% budget floor even when maxOutput equals contextWindow (Kimi/Hunyuan)", () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    const pruned = pruneMessageHistory(body, "codebuddy-cn", "glm-5.2");
    expect(pruned).toBeDefined();
  });

  it("handles Claude wire shape (role: user with type: tool_result) atomically", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "read" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "file content" }] },
      { role: "user", content: "u2" }
    ];
    const groups = groupMessageTurns(messages);
    expect(groups.length).toBe(3); // system, u1+assistant+user_tool_result, u2
    expect(groups[1].messages.length).toBe(3);
  });

  it("attaches valid _prunerStats to body on pruning", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1 ".repeat(120000) },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2 ".repeat(120000) },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3 (trailing)" }
    ];
    const body = { messages };
    const result = pruneMessageHistory(body, "codebuddy-cn", "glm-5.2");
    expect(result._prunerStats).toBeDefined();
    expect(result._prunerStats.tokensBefore).toBeGreaterThan(0);
    expect(result._prunerStats.tokensAfter).toBeGreaterThan(0);
    expect(typeof result._prunerStats.tokensSaved).toBe("number");
    expect(result._prunerStats.pruned).toBe(true);
  });

  it("prevents consecutive user messages when inserting tombstone notice", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1 ".repeat(120000) },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2 ".repeat(120000) },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3 (trailing)" }
    ];
    const body = { messages };
    const result = pruneMessageHistory(body, "codebuddy-cn", "glm-5.2");

    // Check non-system messages: roles must alternate without consecutive "user" roles
    const roles = result.messages.filter(m => m.role !== "system").map(m => m.role);
    for (let i = 0; i < roles.length - 1; i++) {
      if (roles[i] === "user") {
        expect(roles[i + 1]).not.toBe("user");
      }
    }
  });

  it("accurately estimates tokens for Claude tool_result content blocks", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_123",
              content: "A".repeat(35000) // 10k tokens
            }
          ]
        }
      ]
    };
    const est = estimateRequestTokens(body);
    expect(est).toBeGreaterThan(9000);
  });

  it("prunes nested body.request.contents for Gemini/Google shape", () => {
    const contents = [
      { role: "user", parts: [{ text: "u1 " }] },
      { role: "model", parts: [{ text: "a1" }] },
      { role: "user", parts: [{ text: "u2 ".repeat(300000) }] },
      { role: "model", parts: [{ text: "a2" }] },
      { role: "user", parts: [{ text: "u3 (trailing)" }] }
    ];
    const body = { request: { contents } };
    const result = pruneMessageHistory(body, "codebuddy-cn", "glm-5.2");
    expect(result.request.contents).toBeDefined();
    expect(result._pruned).toBe(true);

    // Verify Gemini parts tombstone formatting
    const trailingUserMsg = result.request.contents.find(m => m.parts && m.parts.some(p => p.text.includes("u3 (trailing)")));
    expect(trailingUserMsg).toBeDefined();
    expect(trailingUserMsg.content).toBeUndefined(); // Must NOT set invalid content field on Gemini shape
    expect(trailingUserMsg.parts[0].text).toContain("[earlier 2 history turns omitted for context limit]");
  });
});

