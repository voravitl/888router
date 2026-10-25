import { describe, it, expect } from "vitest";
import { parseUpstreamError } from "../../open-sse/utils/error.js";

// Live evidence (2026-10-25): opencode's free tier answers a 429 with
//
//   HTTP/2 429
//   retry-after: 76074
//   {"type":"error","error":{"type":"FreeUsageLimitError", …}}
//
// parseUpstreamError read only the body, so the 21h window was dropped and the
// gateway parked the pool for its 5s hop cooldown — the client was told
// "(reset after 4s)" and retried into the same wall. The header is the only
// place that window is stated; there is no retryAfter field in the body.

function upstream(status, body, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("parseUpstreamError reads Retry-After", () => {
  it("turns a delta-seconds header into resetsAtMs", async () => {
    const before = Date.now();
    const r = await parseUpstreamError(
      upstream(429, { type: "error", error: { type: "FreeUsageLimitError", message: "Free usage limit reached." } }, { "retry-after": "76074" }),
    );
    expect(r.statusCode).toBe(429);
    expect(r.message).toMatch(/Free usage limit reached/);
    const delta = r.resetsAtMs - before;
    expect(delta).toBeGreaterThan(76073_000);
    expect(delta).toBeLessThan(76075_000);
  });

  it("accepts an HTTP-date header", async () => {
    const at = new Date(Date.now() + 120_000);
    const r = await parseUpstreamError(upstream(503, "busy", { "retry-after": at.toUTCString() }));
    expect(Math.abs(r.resetsAtMs - at.getTime())).toBeLessThan(1000);
  });

  it("leaves resetsAtMs undefined when the header is absent or unusable", async () => {
    expect((await parseUpstreamError(upstream(429, "slow down"))).resetsAtMs).toBeUndefined();
    expect((await parseUpstreamError(upstream(429, "slow down", { "retry-after": "soon" }))).resetsAtMs).toBeUndefined();
    expect((await parseUpstreamError(upstream(429, "slow down", { "retry-after": "0" }))).resetsAtMs).toBeUndefined();
  });

  it("does not override a provider-specific resetsAtMs from the executor", async () => {
    const precise = Date.now() + 5_400_000;
    const executor = { parseError: () => ({ status: 429, message: "codex usage_limit_reached", resetsAtMs: precise }) };
    const r = await parseUpstreamError(upstream(429, "x", { "retry-after": "60" }), executor);
    expect(r.resetsAtMs).toBe(precise);
  });
});
