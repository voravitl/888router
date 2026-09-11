import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { resolveClinepassModels } from "../../open-sse/services/clinepassModels.js";

const realFetch = globalThis.fetch;

// Live wire shape (verified 2026-09-10 against
// GET https://api.cline.bot/api/v1/models): bare `provider/model` ids,
// NO `cline-pass/` prefix (that prefix exists only in models.dev).
// 436 ids, 19 with :free.
const wireBody = {
  object: "list",
  data: [
    { id: "deepseek/deepseek-v4.1-flash" },
    { id: "inclusionai/ling-3.0-flash-fin:free", name: "Ling Flash Fin Free" },
    { id: "nex-agi/nex-n2.5-mini:free" },
    { id: "inclusionai/ling-3.0-flash-fin:free" },
    { id: "" },
    { id: 123 },
    null,
    { id: "bad\x01id" },
    { id: "a".repeat(300) },
    { id: "no-slash-here" },
    { id: "too/many/slashes" },
    { id: "/leading" },
    { id: "trailing/" },
    { id: "../model" },
    { id: "provider/.." },
    { id: "provider/model?x=y" },
    { id: "provider/model#frag" },
    { id: "UPPER/MODEL" },
    { id: "provider/MODEL:X" },
  ],
};

// Test helper: ReadableStream body over the JSON text (production code
// REQUIRES streaming — a text()-only mock would fail-closed by design).
function streamBody(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

describe("clinepass live catalog (bare provider/model ids)", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      body: streamBody(wireBody),
    }));
  });

  it("rejects oversized declared content-length without reading body", async () => {
    let read = false;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: (k) => (k === "content-length" ? String(10 * 1024 * 1024) : null) },
      body: { cancel: vi.fn(async () => {}) },
      text: async () => {
        read = true;
        return "{}";
      },
    }));
    expect(await resolveClinepassModels({ accessToken: "tok" })).toBeNull();
    expect(read).toBe(false);
  });

  it("streaming cap rejects oversized chunked bodies early", async () => {
    const big = new Uint8Array(3 * 1024 * 1024).fill(97);
    let chunks = 0;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(big.slice(0, 1_500_000));
        chunks++;
        c.enqueue(big.slice(0, 1_500_000));
        chunks++;
        c.close();
      },
    });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      body: stream,
      text: async () => {
        throw new Error("must use stream path");
      },
    }));
    expect(await resolveClinepassModels({ accessToken: "tok" })).toBeNull();
    expect(chunks).toBe(2);
  });

  it("sanitizes bidi/C1 controls in display names", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      body: streamBody({
        data: [{ id: "deepseek/x", name: "A‮B\x85C" }],
      }),
    }));
    const result = await resolveClinepassModels({ accessToken: "tok" });
    expect(result.models[0].name).toBe("ABC");
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("accepts bare ids incl. :free (no cline-pass/ prefix gate)", async () => {
    const result = await resolveClinepassModels({ accessToken: "tok" });
    expect(result.models.map((m) => m.id)).toEqual([
      "deepseek/deepseek-v4.1-flash",
      "inclusionai/ling-3.0-flash-fin:free",
      "nex-agi/nex-n2.5-mini:free",
    ]);
  });

  it("rejects traversal/query/fragment/uppercase/malformed ids", async () => {
    // 3 valid + 1 dup + 15 malformed = only the 3 valid survive.
    const result = await resolveClinepassModels({ accessToken: "tok" });
    expect(result.models).toHaveLength(3);
    for (const m of result.models) {
      expect(m.id).not.toMatch(/\.\.|\?|#|\\|[A-Z]/);
      expect(m.id.split("/")).toHaveLength(2);
    }
  });

  it("fail-open to null on non-ok / throw", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false }));
    expect(await resolveClinepassModels({ accessToken: "tok" })).toBeNull();
    globalThis.fetch = vi.fn(async () => {
      throw new Error("down");
    });
    expect(await resolveClinepassModels({ accessToken: "tok" })).toBeNull();
  });

  it("returns null without any credential", async () => {
    expect(await resolveClinepassModels({})).toBeNull();
  });
});
