import { describe, it, expect } from "vitest";
import { computePrefixHash, getRotatedModels } from "../../open-sse/services/combo.js";

// cache-optimized pins a conversation to one model by hashing its cacheable
// prefix. That only helps if the hash actually reads the prefix: Claude (and
// Gemini) send the system prompt at the TOP LEVEL, not as a messages[] entry,
// so a hash that walked messages[] alone gave two unrelated conversations the
// same value and pinned them to the same model regardless of their real prefix.
describe("computePrefixHash sees the real cacheable prefix", () => {
  const user = [{ role: "user", content: "say ok" }];

  it("distinguishes two Claude top-level system prompts", () => {
    const a = { system: "You are Claude Code. ".repeat(50), messages: user };
    const b = { system: "COMPLETELY DIFFERENT SYSTEM PROMPT", messages: user };
    expect(computePrefixHash(a)).not.toBe(computePrefixHash(b));
  });

  it("is stable for the same body, so a conversation stays pinned", () => {
    const body = { system: "stable prompt", messages: user };
    expect(computePrefixHash(body)).toBe(computePrefixHash({ ...body }));
  });

  it("stays stable as the conversation grows", () => {
    const system = "You are Claude Code with a long stable prompt.";
    const turn1 = { system, messages: [{ role: "user", content: "first" }] };
    const turn5 = {
      system,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply one" },
        { role: "user", content: "second" },
        { role: "assistant", content: "reply two" },
        { role: "user", content: "third" },
      ],
    };
    expect(computePrefixHash(turn1)).toBe(computePrefixHash(turn5));
    expect(getRotatedModels(["A", "B", "C"], "c", "cache-optimized", 1, turn1)[0])
      .toBe(getRotatedModels(["A", "B", "C"], "c", "cache-optimized", 1, turn5)[0]);
  });

  it("still distinguishes the OpenAI messages[]-system shape", () => {
    const a = { messages: [{ role: "system", content: "sys A" }, ...user] };
    const b = { messages: [{ role: "system", content: "sys B" }, ...user] };
    expect(computePrefixHash(a)).not.toBe(computePrefixHash(b));
  });

  it("spreads distinct prefixes across models instead of pinning one", () => {
    const seen = new Set();
    for (let i = 0; i < 60; i++) {
      const body = { system: `project ${i} instructions`, messages: user };
      seen.add(getRotatedModels(["A", "B", "C"], "c", "cache-optimized", 1, body)[0]);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("falls back to the first message when there is no system at all", () => {
    const a = { messages: [{ role: "user", content: "alpha" }] };
    const b = { messages: [{ role: "user", content: "beta" }] };
    expect(computePrefixHash(a)).not.toBe(computePrefixHash(b));
  });
});