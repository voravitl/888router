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
});
