import { describe, it, expect } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";

describe("OpenCodeExecutor.transformRequest - t2 max_tokens injection", () => {
  const executor = new OpenCodeExecutor();

  it("injects max_tokens: 2000 for -free models when max_tokens is absent", () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    const res = executor.transformRequest("deepseek-v4-flash-free", body);
    expect(res.max_tokens).toBe(2000);
  });

  it("preserves explicit max_tokens for -free models", () => {
    const body = { messages: [{ role: "user", content: "hello" }], max_tokens: 500 };
    const res = executor.transformRequest("deepseek-v4-flash-free", body);
    expect(res.max_tokens).toBe(500);
  });

  it("does NOT inject max_tokens for non-free models when max_tokens is absent", () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    const res = executor.transformRequest("claude-sonnet-4-6", body);
    expect(res.max_tokens).toBeUndefined();
  });

  it("sanitizes null or undefined message content to empty string when not a tool_call", () => {
    const body = {
      messages: [
        { role: "user", content: null },
        { role: "assistant", content: undefined },
        { role: "assistant", content: null, tool_calls: [] },
        { role: "assistant", tool_calls: [{ id: "call_1" }] },
        { role: "tool", content: null, tool_call_id: "call_1" },
      ],
    };
    const res = executor.transformRequest("claude-sonnet-4-6", body);
    expect(res.messages[0].content).toBe("");
    expect(res.messages[1].content).toBe("");
    expect(res.messages[2].content).toBe("");
    expect(res.messages[3].content).toBeUndefined();
    expect(res.messages[3].tool_calls).toBeDefined();
    expect(res.messages[4].content).toBe("");
  });
});

