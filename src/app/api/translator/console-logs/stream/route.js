import { flushConsoleLogs, getConsoleLogs, getConsoleEmitter, initConsoleLogCapture } from "@/lib/consoleLogBuffer";

export const dynamic = "force-dynamic";

initConsoleLogCapture();

export async function GET(request) {
  const encoder = new TextEncoder();
  const emitter = getConsoleEmitter();
  const state = { closed: false, send: null, sendLines: null, sendClear: null, keepalive: null };

  // Idempotent: safe to call from request.signal abort, cancel(), or enqueue failure.
  const cleanup = () => {
    if (state.closed) return;
    state.closed = true;
    if (state.send) emitter.off("line", state.send);
    if (state.sendLines) emitter.off("lines", state.sendLines);
    if (state.sendClear) emitter.off("clear", state.sendClear);
    if (state.keepalive) clearInterval(state.keepalive);
  };

  // request.signal fires reliably on client disconnect; ReadableStream.cancel()
  // is not always invoked in Next.js, which caused listeners to accumulate.
  request?.signal?.addEventListener?.("abort", cleanup, { once: true });

  const stream = new ReadableStream({
    start(controller) {
      // Flush any pre-connect pending batch before reading init + subscribing so
      // a connecting client never receives the same lines twice (once in init, once in lines).
      flushConsoleLogs();
      // Always enqueue an initial SSE frame immediately (even when logs is empty);
      // omitting it stalls Next.js standalone header flush until the first keepalive ping (25s),
      // leaving EventSource stuck on "RECONNECTING..." in the UI.
      const buffered = getConsoleLogs();
      controller.enqueue(encoder.encode(`retry: 3000\ndata: ${JSON.stringify({ type: "init", logs: buffered })}\n\n`));

      // Push new lines as they arrive
      state.send = (line) => {
        if (state.closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "line", line })}\n\n`));
        } catch {
          cleanup();
        }
      };

      state.sendLines = (lines) => {
        if (state.closed || !Array.isArray(lines) || lines.length === 0) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "lines", lines })}\n\n`));
        } catch {
          cleanup();
        }
      };

      // Notify client when cleared
      state.sendClear = () => {
        if (state.closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "clear" })}\n\n`));
        } catch {
          cleanup();
        }
      };

      emitter.on("line", state.send);
      emitter.on("lines", state.sendLines);
      emitter.on("clear", state.sendClear);

      // Keepalive ping every 15s
      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 15000);
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
