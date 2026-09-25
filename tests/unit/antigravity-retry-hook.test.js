// Guards D3: antigravity 429/503 retry merged into base via computeRetryDelay hook.
import { describe, it, expect } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

const MAX = 10000;
function res(status, headers = {}, body = null) {
  return {
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    clone: () => ({ text: async () => (body == null ? "" : JSON.stringify(body)) }),
  };
}

describe("antigravity computeRetryDelay hook (D3)", () => {
  const ag = new AntigravityExecutor();

  it("uses Retry-After header (seconds → ms) when within cap", async () => {
    expect(await ag.computeRetryDelay(res(429, { "retry-after": "5" }), 1)).toBe(5000);
  });

  it("vetoes (false) when Retry-After exceeds cap", async () => {
    expect(await ag.computeRetryDelay(res(429, { "retry-after": "60" }), 1)).toBe(false);
  });

  it("parses retry time from error body when no header", async () => {
    const r = res(429, {}, { error: { message: "quota will reset after 3s" } });
    expect(await ag.computeRetryDelay(r, 1)).toBe(3000);
  });

  it("exponential backoff for 429 when no retry info", async () => {
    expect(await ag.computeRetryDelay(res(429), 1)).toBe(Math.min(1000 * 2 ** 1, MAX));
    expect(await ag.computeRetryDelay(res(429), 3)).toBe(Math.min(1000 * 2 ** 3, MAX));
  });

  it("503 without retry info → transient backoff", async () => {
    expect(await ag.computeRetryDelay(res(503), 1)).toBe(2000);
  });

  it("retries Antigravity agent terminated body even when status is not 429", async () => {
    const r = res(500, {}, { error: { message: "Agent execution terminated due to error" } });
    expect(await ag.computeRetryDelay(r, 1)).toBe(2000);
  });

  it("retries high traffic body", async () => {
    const r = res(500, {}, { error: { message: "Our servers are experiencing high traffic" } });
    expect(await ag.computeRetryDelay(r, 2)).toBe(4000);
  });

  it("does not retry non-transient 400 errors", async () => {
    const r = res(400, {}, { error: { message: "Invalid request" } });
    expect(await ag.computeRetryDelay(r, 1)).toBe(false);
  });

  it("vetoes (false) on the observed 80h individual-quota envelope (RetryInfo.retryDelay)", async () => {
    // Regression: 0.15.117 burned ~95s retrying a quota wall that resets in 80h
    // (12:29:53 → 12:31:33 in the pod log) before the combo could fail over.
    const r = res(429, {}, {
      error: {
        code: 429,
        message: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 80h25m39s.",
        status: "RESOURCE_EXHAUSTED",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED",
            domain: "cloudcode-pa.googleapis.com", metadata: {
              quotaResetTimeStamp: new Date(Date.now() + 80 * 3600 * 1000).toISOString(),
            } },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "289539.38s" },
        ],
      },
    });
    expect(await ag.computeRetryDelay(r, 1)).toBe(false);
  });

  it("vetoes (false) when quotaResetTimeStamp is far in the future (no RetryInfo)", async () => {
    const r = res(429, {}, {
      error: {
        code: 429,
        message: "Individual quota reached. Resets in 80h.",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", metadata: {
            quotaResetTimeStamp: new Date(Date.now() + 80 * 3600 * 1000).toISOString(),
          } },
        ],
      },
    });
    expect(await ag.computeRetryDelay(r, 1)).toBe(false);
  });

  it("parses 'Resets in 80h25m39s' message text when no structured details exist", () => {
    expect(ag.parseRetryFromErrorMessage(
      "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 80h25m39s.",
    )).toBe(((80 * 60 + 25) * 60 + 39) * 1000);
  });

  it("still parses the legacy 'reset after' spelling", () => {
    expect(ag.parseRetryFromErrorMessage("Your quota will reset after 2h7m23s")).toBe(((2 * 60 + 7) * 60 + 23) * 1000);
  });

  it("deduplicates sanitized tool names", () => {
    const out = ag.transformRequest("claude-opus-4-6-thinking", {
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [{ functionDeclarations: [
          { name: "read/file", parameters: { type: "object", properties: {} } },
          { name: "read file", parameters: { type: "object", properties: {} } },
          { name: "read/file", parameters: { type: "object", properties: {} } },
        ] }],
      },
    }, true, { projectId: "project-1", connectionId: "conn-1" });

    expect(out.request.tools[0].functionDeclarations.map(fn => fn.name)).toEqual(["read_file"]);
  });

  it("buildHeaders includes cached session id after transformRequest", () => {
    ag._lastSessionId = "sess-123";
    const h = ag.buildHeaders({ accessToken: "tok" }, true);
    expect(h["X-Machine-Session-Id"]).toBe("sess-123");
  });
});
