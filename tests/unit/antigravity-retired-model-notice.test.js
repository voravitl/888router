import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.proxyAwareFetch }));

import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { handleComboChat, clearComboKnownUnavailable } from "../../open-sse/services/combo.js";

beforeEach(() => clearComboKnownUnavailable());
afterEach(() => clearComboKnownUnavailable());

// Exact upstream envelope observed on 2026-10-03, with no completion metadata.
const notice = "Claude Opus 4.6 is no longer available. Please switch to Claude Opus 5.5.";
const nativeNotice = (text = notice) => ({ response: {
  candidates: [{ content: { role: "model", parts: [{ text }] } }],
} });
const jsonResponse = (body) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json", "content-length": "999", "x-provider-test": "kept" },
});
const execute = (stream = false) => new AntigravityExecutor().execute({
  model: "claude-opus-4-6-thinking", stream,
  body: { request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } },
  credentials: { accessToken: "test-only", projectId: "test-project" },
});

describe("Antigravity model-retirement notice normalization", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    notice,
    "Gemini 3.1 Pro is no longer available. Please switch to Gemini 3.8 Pro.",
  ])("normalizes metadata-free native notice without enumerating model IDs: %s", async (text) => {
    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonResponse(nativeNotice(text)));
    const result = await execute();
    expect(result.response.status).toBe(404);
    expect(result.response.headers.get("content-length")).toBeNull();
    expect(result.response.headers.get("x-provider-test")).toBe("kept");
    const error = (await result.response.json()).error;
    expect(error).toEqual({ type: "invalid_request_error", code: "model_not_found", message: text });
    // The account layer returns before writing any cooldown/health failure
    // for shouldFallback=false; the combo sees modelError and tries next model.
    expect(checkFallbackError(404, JSON.stringify(error))).toMatchObject({
      modelError: true, shouldFallback: false, cooldownMs: 0,
    });
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["finishReason", "modelVersion", "usageMetadata"])("preserves a real completion quoting the notice when %s exists", async (field) => {
    const body = nativeNotice();
    if (field === "finishReason") body.response.candidates[0].finishReason = "STOP";
    else body.response[field] = field === "usageMetadata" ? { promptTokenCount: 25 } : "gemini-test";
    const original = jsonResponse(body);
    mocks.proxyAwareFetch.mockResolvedValueOnce(original);
    const result = await execute();
    expect(result.response).toBe(original);
    expect(await result.response.json()).toEqual(body);
  });

  it("normalizes a JSON notice even when the client requested a stream", async () => {
    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonResponse(nativeNotice()));
    expect((await execute(true)).response.status).toBe(404);
  });

  it("preserves a wrapped completion whose usage metadata is on the outer envelope", async () => {
    const body = { ...nativeNotice(), usageMetadata: { promptTokenCount: 25 } };
    const original = jsonResponse(body);
    mocks.proxyAwareFetch.mockResolvedValueOnce(original);
    expect((await execute()).response).toBe(original);
  });

  it("preserves malformed JSON for the existing response handler", async () => {
    const original = new Response("{invalid", { headers: { "content-type": "application/json" } });
    mocks.proxyAwareFetch.mockResolvedValueOnce(original);
    expect((await execute()).response).toBe(original);
    expect(await original.text()).toBe("{invalid");
  });

  it.each([false, true])("bounds large ordinary JSON inspection and preserves its body (known length: %s)", async (knownLength) => {
    const text = JSON.stringify(nativeNotice("ordinary answer ".repeat(2000)));
    const headers = { "content-type": "application/json" };
    if (knownLength) headers["content-length"] = String(Buffer.byteLength(text));
    const original = new Response(new ReadableStream({
      start(controller) {
        const encoded = new TextEncoder().encode(text);
        controller.enqueue(encoded.slice(0, 5000));
        controller.enqueue(encoded.slice(5000));
        controller.close();
      },
    }), { headers });
    const clone = vi.spyOn(original, "clone");
    mocks.proxyAwareFetch.mockResolvedValueOnce(original);
    expect((await execute()).response).toBe(original);
    expect(original.bodyUsed).toBe(false);
    expect(clone).toHaveBeenCalledTimes(knownLength ? 0 : 1);
    expect(await original.text()).toBe(text);
  });

  it.each([
    `The documentation says: ${notice}`,
    `"${notice}"`,
    "Hello, I can help with the task.",
  ])("preserves ordinary metadata-free answers: %s", async (text) => {
    const original = jsonResponse(nativeNotice(text));
    mocks.proxyAwareFetch.mockResolvedValueOnce(original);
    expect((await execute()).response).toBe(original);
    expect(await original.json()).toEqual(nativeNotice(text));
  });

  it("preserves tool parts and multi-part completions containing the notice", async () => {
    const body = nativeNotice();
    body.response.candidates[0].content.parts.push({ functionCall: { name: "read_file", args: {} } });
    const original = jsonResponse(body);
    mocks.proxyAwareFetch.mockResolvedValueOnce(original);
    expect((await execute()).response).toBe(original);
  });

  it("preserves normal SSE responses and their original body", async () => {
    const original = new Response(`data: ${JSON.stringify(nativeNotice("ordinary answer"))}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
    mocks.proxyAwareFetch.mockResolvedValueOnce(original);
    expect((await execute()).response).toBe(original);
    expect(original.bodyUsed).toBe(false);
    expect(await original.text()).toContain("ordinary answer");
  });

  it.each(["\n", "\r\n"])("normalizes a lone native SSE notice ending at EOF with %j separators", async (newline) => {
    const frame = `data: ${JSON.stringify(nativeNotice())}${newline}${newline}`;
    mocks.proxyAwareFetch.mockResolvedValueOnce(new Response(frame, { headers: { "content-type": "text/event-stream" } }));
    const result = await execute(true);
    expect(result.response.status).toBe(404);
    expect((await result.response.json()).error.code).toBe("model_not_found");
  });

  it("normalizes a notice followed by [DONE] without waiting for EOF", async () => {
    const original = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(nativeNotice())}\n\ndata: [DONE]\n\n`));
    } }), { headers: { "content-type": "text/event-stream" } });
    mocks.proxyAwareFetch.mockResolvedValueOnce(original);
    expect((await execute(true)).response.status).toBe(404);
  });

  it("preserves a streamed quoted notice followed by completion metadata", async () => {
    const frames = `data: ${JSON.stringify(nativeNotice())}\n\ndata: ${JSON.stringify({ response: { usageMetadata: { promptTokenCount: 20 }, candidates: [{ finishReason: "STOP" }] } })}\n\n`;
    const original = new Response(frames, { headers: { "content-type": "text/event-stream" } });
    mocks.proxyAwareFetch.mockResolvedValueOnce(original);
    expect((await execute(true)).response).toBe(original);
    expect(await original.text()).toBe(frames);
  });

  it("returns a nonterminal notice stream unchanged within the inspection deadline", async () => {
    const original = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(nativeNotice())}\n\n`));
    } }), { headers: { "content-type": "text/event-stream" } });
    mocks.proxyAwareFetch.mockResolvedValueOnce(original);
    const started = Date.now();
    expect((await execute(true)).response).toBe(original);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(original.bodyUsed).toBe(false);
    void original.body.cancel();
  });

  it("bounds a stalled JSON body inspection and leaves the original readable", async () => {
    let controller;
    const original = new Response(new ReadableStream({ start(c) { controller = c; } }), {
      headers: { "content-type": "application/json" },
    });
    mocks.proxyAwareFetch.mockResolvedValueOnce(original);
    const started = Date.now();
    expect((await execute()).response).toBe(original);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(original.bodyUsed).toBe(false);
    controller.enqueue(new TextEncoder().encode(JSON.stringify(nativeNotice("normal answer"))));
    controller.close();
    expect(await original.json()).toEqual(nativeNotice("normal answer"));
  });

  it.each([true, false])("supports clone-less DNS-bypass transport and preserves ordinary bodies (notice: %s)", async (retired) => {
    const payload = nativeNotice(retired ? notice : "normal answer");
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    const native = new Response(frame);
    mocks.proxyAwareFetch.mockResolvedValueOnce({
      ok: true, status: 200, statusText: "OK",
      headers: new Map([["content-type", "text/event-stream"]]), body: native.body,
    });
    const result = await execute(true);
    expect(result.response.status).toBe(retired ? 404 : 200);
    if (retired) expect((await result.response.json()).error.code).toBe("model_not_found");
    else expect(await result.response.text()).toBe(frame);
  });

  it.each([204, 205])("preserves bodyless status %s without wrapping or inspecting", async (status) => {
    const original = { ok: true, status, headers: new Map([["content-type", "application/json"]]), body: null };
    mocks.proxyAwareFetch.mockResolvedValueOnce(original);
    expect((await execute()).response).toBe(original);
  });

  it("returns ordinary first SSE frame immediately without waiting for the stream to finish", async () => {
    let controller;
    const frame = `data: ${JSON.stringify(nativeNotice("normal answer"))}\n\n`;
    const original = new Response(new ReadableStream({ start(c) {
      controller = c;
      c.enqueue(new TextEncoder().encode(frame));
    } }), { headers: { "content-type": "text/event-stream" } });
    mocks.proxyAwareFetch.mockResolvedValueOnce(original);
    const started = Date.now();
    expect((await execute(true)).response).toBe(original);
    expect(Date.now() - started).toBeLessThan(500);
    controller.close();
    expect(await original.text()).toBe(frame);
  });

  it("lets the real combo fall through from retired provider model to a healthy model", async () => {
    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonResponse(nativeNotice()));
    const seen = [];
    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["ag/claude-opus-4-6-thinking", "cx/gpt-6.1-sol"],
      handleSingleModel: async (_body, model) => {
        seen.push(model);
        if (model.startsWith("ag/")) return (await execute()).response;
        return jsonResponse({ choices: [{ message: { role: "assistant", content: "actual answer" }, finish_reason: "stop" }] });
      },
      log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      comboName: "retired-notice-regression", comboStrategy: "fallback",
    });
    expect(seen).toEqual(["ag/claude-opus-4-6-thinking", "cx/gpt-6.1-sol"]);
    expect(result.status).toBe(200);
    expect((await result.json()).choices[0].message.content).toBe("actual answer");
  });
});
