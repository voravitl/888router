import { describe, expect, it } from "vitest";
import { handleStreamingResponse } from "open-sse/handlers/chatCore/streamingHandler.js";

function ndjsonBody(lines) {
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

function fakeController() {
  const c = new AbortController();
  return {
    signal: c.signal,
    startTime: Date.now(),
    isConnected: () => true,
    handleComplete: () => {},
    handleError: () => {},
    handleDisconnect: () => {},
    abort: () => c.abort(),
  };
}
function ctx(contentType, lines) {
  return {
    providerResponse: new Response(ndjsonBody(lines), {
      status: 200,
      headers: { "content-type": contentType },
    }),
    provider: "ollama-local",
    model: "qwen2.5-coder:14b-instruct-q8_0",
    sourceFormat: "openai",
    targetFormat: "ollama",
    userAgent: "test",
    body: { model: "qwen2.5-coder:14b-instruct-q8_0", stream: true },
    stream: true,
    translatedBody: null,
    finalBody: null,
    requestStartTime: Date.now(),
    connectionId: "test-conn",
    apiKey: null,
    clientRawRequest: null,
    onRequestSuccess: null,
    reqLogger: null,
    log: () => {},
    toolNameMap: null,
    streamController: fakeController(),
    onStreamComplete: null,
    streamDetailId: null,
  };
}

const NDJSON_LINES = [
  { model: "q", message: { role: "assistant", content: "hi" }, done: false },
  { model: "q", done: true, done_reason: "stop", prompt_eval_count: 5, eval_count: 2 },
];

describe("streamingHandler x-ndjson gate (ollama-local)", () => {
  it("pipes application/x-ndjson instead of blocking", async () => {
    const { success, response } = await handleStreamingResponse(ctx("application/x-ndjson", NDJSON_LINES));
    expect(success).toBe(true);
    const text = await response.text();
    expect(text).toContain("data: ");
    expect(text).toContain("chatcmpl-");
  });

  it("still blocks ndjson when target is not ollama", async () => {
    const other = {
      ...ctx("application/x-ndjson", NDJSON_LINES),
      targetFormat: "openai",
    };
    const { success, response } = await handleStreamingResponse(other);
    expect(success).toBe(false);
    expect(response.status).toBe(200);
  });

  it("still blocks non-SSE HTML error pages", async () => {
    const bad = {
      ...ctx("text/html", NDJSON_LINES),
      providerResponse: new Response("<html><title>502 Bad Gateway</title></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    };
    const { success, response } = await handleStreamingResponse(bad);
    expect(success).toBe(false);
    expect(response.status).toBe(502);
  });
});
