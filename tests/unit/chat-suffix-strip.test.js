import { describe, expect, it } from "vitest";

// Claude Code reads context window from a hardcoded binary registry, not from
// /v1/models. It activates its 1M-context entry by appending "[1m]" to the
// model id. Upstreams (z.ai etc.) reject the suffix as "Unknown Model", so
// src/sse/handlers/chat.js strips it at the chat boundary before routing.
// These tests cover the regex in isolation — the handler composes it inline.

const STRIP_RE = /\[1m\]$/i;
function stripSuffix(m) {
  return typeof m === "string" && STRIP_RE.test(m) ? m.replace(STRIP_RE, "") : m;
}

describe("chat [1m] suffix strip", () => {
  it("strips trailing [1m] from a model id", () => {
    expect(stripSuffix("glm/glm-5.2[1m]")).toBe("glm/glm-5.2");
  });

  it("strips [1M] uppercase (case-insensitive)", () => {
    expect(stripSuffix("glm/glm-5.2[1M]")).toBe("glm/glm-5.2");
  });

  it("strips from dash/date-suffixed ids", () => {
    expect(stripSuffix("glm-5-2-260617[1m]")).toBe("glm-5-2-260617");
  });

  it("leaves a bare model id untouched", () => {
    expect(stripSuffix("glm/glm-5.2")).toBe("glm/glm-5.2");
  });

  it("does not strip [1m] in the middle of an id (anchored at end)", () => {
    expect(stripSuffix("foo-[1m]-bar")).toBe("foo-[1m]-bar");
  });

  it("does not throw on non-string model (undefined/null/array)", () => {
    expect(stripSuffix(undefined)).toBeUndefined();
    expect(stripSuffix(null)).toBeNull();
    expect(stripSuffix(["glm/glm-5.2[1m]"])).toEqual(["glm/glm-5.2[1m]"]);
  });
});
