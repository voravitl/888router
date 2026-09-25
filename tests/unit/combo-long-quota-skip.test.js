// Regression: long account-level quota windows (antigravity 429 "Individual
// quota reached … Resets in 80h25m39s", quotaResetTimeStamp 2026-09-28) must
// not burn the remaining same-provider combo candidates. In 0.15.117 a
// 9-sonnet request failed over from 4/5 ag/claude-sonnet-4-6 (429 after ~95s
// of in-executor retries) to 5/5 ag/gemini-3.8-flash-medium — the SAME
// account/quota — and delivered a second 429 to the client as the verdict.
import { describe, it, expect, vi } from "vitest";

describe("handleComboChat: long quota windows skip same-provider candidates", () => {
  let handleComboChat;
  beforeAll(async () => {
    ({ handleComboChat } = await import("../../open-sse/services/combo.js"));
  });

  const log = { info: vi.fn(), warn: vi.fn() };

  // Google-style 429 envelope as observed from cloudcode-pa.googleapis.com.
  const antigravity429 = () =>
    new Response(
      JSON.stringify({
        error: {
          code: 429,
          message: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 80h25m39s.",
          status: "RESOURCE_EXHAUSTED",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "QUOTA_EXHAUSTED",
              domain: "cloudcode-pa.googleapis.com",
              metadata: { quotaResetTimeStamp: new Date(Date.now() + 80 * 3600 * 1000).toISOString() },
            },
            { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "289539.38s" },
          ],
        },
      }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );

  const ok = () =>
    new Response(
      JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  it("skips remaining same-provider models and succeeds on a different provider", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      seen.push(model);
      if (model.startsWith("ag/")) return antigravity429();
      return ok();
    });

    const result = await handleComboChat({
      body: { model: "c", messages: [{ role: "user", content: "hi" }] },
      models: ["ag/claude-sonnet-4-6", "ag/gemini-3.8-flash-medium", "kr/claude-sonnet-5"],
      handleSingleModel,
      log,
      comboName: "c",
      comboStrategy: "fallback",
    });

    expect(result.status).toBe(200);
    // ag/gemini-3.8-flash-medium must NEVER be tried after ag/claude 429s with
    // an 80h window — the combo jumps straight to kr/claude-sonnet-5.
    expect(seen).toEqual(["ag/claude-sonnet-4-6", "kr/claude-sonnet-5"]);
  });

  it("stops with 429 immediately when every remaining candidate shares the provider", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      seen.push(model);
      return antigravity429();
    });

    const result = await handleComboChat({
      body: { model: "c", messages: [{ role: "user", content: "hi" }] },
      models: ["ag/claude-sonnet-4-6", "ag/gemini-3.8-flash-medium"],
      handleSingleModel,
      log,
      comboName: "c",
      comboStrategy: "fallback",
    });

    expect(result.status).toBe(429);
    // The second candidate shares the exhausted ag account/quota, so the combo
    // stops right away instead of trying it and 429ing again.
    expect(seen).toEqual(["ag/claude-sonnet-4-6"]);
  });

  it("does NOT skip same-provider candidates on a short rate limit (RPM-style)", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      seen.push(model);
      // Short window retry-after (30s) — the next model may have its own headroom.
      if (model === "p1/m1") {
        return new Response(
          JSON.stringify({ error: { message: "Rate limit exceeded", retryAfter: new Date(Date.now() + 30 * 1000).toISOString() } }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        );
      }
      return ok();
    });

    const result = await handleComboChat({
      body: { model: "c", messages: [{ role: "user", content: "hi" }] },
      models: ["p1/m1", "p1/m2"],
      handleSingleModel,
      log,
      comboName: "c",
      comboStrategy: "fallback",
    });

    expect(result.status).toBe(200);
    expect(seen).toEqual(["p1/m1", "p1/m2"]);
  });
});
describe("handleComboChat: 'Resets in' text fallback (chatCore re-wrap gap)", () => {
  const log = { info: vi.fn(), warn: vi.fn() };
  const ok = () =>
    new Response(
      JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  it("skips same-provider candidates when details[] is gone but message text carries 'Resets in 78h1m5s'", async () => {
    const { handleComboChat } = await import("../../open-sse/services/combo.js");
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      seen.push(model);
      if (model.startsWith("ag/")) {
        // This is what combo actually receives live: chatCore re-wraps the
        // upstream 429 into {"error":{"message":"[429]: …Resets in 78h1m5s."}}
        // — no details[] array survives.
        return new Response(
          JSON.stringify({ error: { message: "[antigravity/claude-sonnet-4-6] [429]: {\"error\":{\"message\":\"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 78h1m5s.\"}}" } }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        );
      }
      return ok();
    });

    const result = await handleComboChat({
      body: { model: "c", messages: [{ role: "user", content: "hi" }] },
      models: ["ag/claude-sonnet-4-6", "ag/gemini-3.8-flash-medium", "kr/claude-sonnet-5"],
      handleSingleModel,
      log,
      comboName: "c",
      comboStrategy: "fallback",
    });

    expect(result.status).toBe(200);
    expect(seen).toEqual(["ag/claude-sonnet-4-6", "kr/claude-sonnet-5"]);
  });

  it("does NOT skip on a short 'Resets in 45s' text", async () => {
    const { handleComboChat } = await import("../../open-sse/services/combo.js");
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      seen.push(model);
      if (model === "p1/m1") {
        return new Response(
          JSON.stringify({ error: { message: "[p1/m1] [429]: quota exceeded. Resets in 45s." } }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        );
      }
      return ok();
    });

    const result = await handleComboChat({
      body: { model: "c", messages: [{ role: "user", content: "hi" }] },
      models: ["p1/m1", "p1/m2"],
      handleSingleModel,
      log,
      comboName: "c",
      comboStrategy: "fallback",
    });

    expect(result.status).toBe(200);
    expect(seen).toEqual(["p1/m1", "p1/m2"]);
  });
});
