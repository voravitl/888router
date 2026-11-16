import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  clearConsoleLogs,
  getConsoleLogs,
  initConsoleLogCapture,
} from "../../src/lib/consoleLogBuffer.js";

describe("consoleLogBuffer and /api/translator/console-logs/stream", () => {
  beforeEach(() => {
    clearConsoleLogs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flushes an immediate init SSE frame even when the buffer is empty", async () => {
    initConsoleLogCapture();
    clearConsoleLogs();

    const { GET } = await import("../../src/app/api/translator/console-logs/stream/route.js");
    const abortCtrl = new AbortController();
    const res = await GET(new Request("http://localhost:20129/api/translator/console-logs/stream", {
      signal: abortCtrl.signal,
    }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const firstRead = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("SSE initial flush stalled")), 500)),
    ]);

    expect(firstRead.done).toBe(false);
    const firstChunk = dec.decode(firstRead.value);
    expect(firstChunk).toContain('data: {"type":"init","logs":[]}');

    abortCtrl.abort();
    await reader.cancel().catch(() => {});
  });

  it("streams new console output live after connecting", async () => {
    initConsoleLogCapture();
    clearConsoleLogs();

    const { GET } = await import("../../src/app/api/translator/console-logs/stream/route.js");
    const abortCtrl = new AbortController();
    const res = await GET(new Request("http://localhost:20129/api/translator/console-logs/stream", {
      signal: abortCtrl.signal,
    }));

    const reader = res.body.getReader();
    const dec = new TextDecoder();

    // Drain initial frame
    await reader.read();

    const marker = `live-console-probe-${Date.now()}`;
    console.log(marker);

    const nextRead = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Live SSE log did not arrive")), 1000)),
    ]);

    expect(nextRead.done).toBe(false);
    const chunk = dec.decode(nextRead.value);
    expect(chunk).toContain('"type":"lines"');
    expect(chunk).toContain(marker);

    abortCtrl.abort();
    await reader.cancel().catch(() => {});
  });

  it("drops pending un-flushed lines on clearConsoleLogs so cleared logs do not reappear", async () => {
    initConsoleLogCapture();
    clearConsoleLogs();

    const { GET } = await import("../../src/app/api/translator/console-logs/stream/route.js");
    const abortCtrl = new AbortController();
    const res = await GET(new Request("http://localhost:20129/api/translator/console-logs/stream", {
      signal: abortCtrl.signal,
    }));

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    await reader.read(); // init

    console.log("line-before-clear");
    clearConsoleLogs();

    const nextRead = await reader.read();
    const chunk = dec.decode(nextRead.value);
    expect(chunk).toContain('{"type":"clear"}');
    expect(chunk).not.toContain("line-before-clear");

    // Wait past FLUSH_INTERVAL_MS (100ms) to ensure nothing flushed after clear
    await new Promise((r) => setTimeout(r, 150));
    expect(getConsoleLogs()).toEqual([]);

    abortCtrl.abort();
    await reader.cancel().catch(() => {});
  });

  it("does not replay pre-connect lines a second time via lines after init", async () => {
    initConsoleLogCapture();
    clearConsoleLogs();

    const preMarker = `pre-connect-${Date.now()}`;
    const postMarker = `post-connect-${Date.now()}`;
    console.log(preMarker);

    const { GET } = await import("../../src/app/api/translator/console-logs/stream/route.js");
    const abortCtrl = new AbortController();
    const res = await GET(new Request("http://localhost:20129/api/translator/console-logs/stream", {
      signal: abortCtrl.signal,
    }));

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const first = dec.decode((await reader.read()).value);
    expect(first).toContain(preMarker);

    console.log(postMarker);
    const second = dec.decode((await reader.read()).value);
    expect(second).toContain(postMarker);
    expect(second).not.toContain(preMarker);

    abortCtrl.abort();
    await reader.cancel().catch(() => {});
  });

  it("registers console capture on Node server startup via instrumentation register()", async () => {
    const prevRuntime = process.env.NEXT_RUNTIME;
    const prevPhase = process.env.NEXT_PHASE;
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.NEXT_PHASE;

    try {
      const mod = await import("../../src/instrumentation.js");
      expect(typeof mod.register).toBe("function");
      await mod.register();
      expect(global._consoleLogBufferState?.patched).toBe(true);
    } finally {
      if (prevRuntime === undefined) delete process.env.NEXT_RUNTIME;
      else process.env.NEXT_RUNTIME = prevRuntime;
      if (prevPhase !== undefined) process.env.NEXT_PHASE = prevPhase;
    }
  });
});
