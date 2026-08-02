// Stream handler with disconnect detection - shared for all providers
import { STREAM_STALL_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

// Get HH:MM:SS timestamp
function getTimeString() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Create stream controller with abort and disconnect detection
 * @param {object} options
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {object} options.log - Logger instance
 * @param {string} options.provider - Provider name
 * @param {string} options.model - Model name
 */
export function createStreamController({ onDisconnect, onError, log, provider, model } = {}) {
  const abortController = new AbortController();
  const startTime = Date.now();
  let disconnected = false;
  let abortTimeout = null;

  const logStream = (status) => {
    const duration = Date.now() - startTime;
    const p = provider?.toUpperCase() || "UNKNOWN";
    console.log(`[${getTimeString()}] 🌊 [STREAM] ${p} | ${model || "unknown"} | ${duration}ms | ${status}`);
  };

  return {
    signal: abortController.signal,
    startTime,

    isConnected: () => !disconnected,

    // Call when client disconnects
    handleDisconnect: (reason = "client_closed") => {
      if (disconnected) return;
      disconnected = true;

      logStream(`disconnect: ${reason}`);
      dbg("CTRL", `${provider}/${model} | disconnect=${reason} | dur=${Date.now() - startTime}ms`);

      // Delay abort to allow cleanup
      abortTimeout = setTimeout(() => {
        abortController.abort();
      }, 500);

      onDisconnect?.({ reason, duration: Date.now() - startTime });
    },

    // Call when stream completes normally
    handleComplete: () => {
      if (disconnected) return;
      disconnected = true;

      logStream("complete");

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }
    },

    // Call on error
    handleError: (error) => {
      if (disconnected) return;
      disconnected = true;

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }

      if (error.name === "AbortError") {
        logStream("aborted");
        return;
      }

      logStream(`error: ${error.message}`);
      onError?.(error);
    },

    abort: () => abortController.abort()
  };
}

/**
 * Create transform stream with disconnect detection
 * Wraps existing transform stream and adds abort capability.
 *
 * Stall detection lives in pipeWithDisconnect (tied to upstream byte
 * activity), not here — output of the transform stream may be silent
 * for long periods while raw bytes still flow (e.g. Kiro EventStream
 * binary frames buffering, Claude reasoning streams).
 */
export function createDisconnectAwareStream(transformStream, streamController, onAbortTerminal = null) {
  const reader = transformStream.readable.getReader();
  const writer = transformStream.writable.getWriter();
  let terminalEmitted = false;

  // Track open content_block_start indices from Claude SSE output so we can
  // close them before synthesizing a terminal event on upstream abort.
  // Without this, message_stop is emitted while blocks are still open →
  // Claude Code: "Content block not found"
  const openBlockIndices = new Set();
  // Accumulate incomplete SSE lines across chunks so a `data:` JSON payload
  // split mid-chunk is not mis-parsed (HIGH: chunk-boundary scanning). We only
  // care about content_block_start/stop events, but the line must be complete
  // before JSON.parse, otherwise a truncated payload silently misses the block.
  let scanBuffer = '';
  // Long-lived decoder so multibyte UTF-8 split across chunks decodes cleanly
  // (HIGH: per-chunk `new TextDecoder().decode(value)` corrupts split codepoints).
  const scanDecoder = new TextDecoder();
  // Cap the scan buffer against slowloris/bad providers that stream without
  // newlines (MEDIUM: unbounded memory growth).
  const SCAN_BUFFER_MAX = 1024 * 1024; // 1MB

  // Best-effort parse of any trailing SSE text left in the buffer, so an
  // abort that lands mid-event still records a block start/stop it may have
  // missed (HIGH: truncated stop could otherwise leave a stale open index).
  // Splits on \n exactly like scanForBlockEvents so a `event:\ndata:` pair
  // without a trailing newline is still parsed (M2: don't trim the whole
  // buffer and bail because it doesn't start with "data:").
  const parseDataLine = (line) => {
    if (!line.startsWith('data:')) return;
    try {
      const json = JSON.parse(line.slice(5).trim());
      if (json.type === 'content_block_start' && typeof json.index === 'number') {
        openBlockIndices.add(json.index);
      } else if (json.type === 'content_block_stop' && typeof json.index === 'number') {
        openBlockIndices.delete(json.index);
      }
    } catch { /* not JSON or not a block event */ }
  };

  const scanBuffered = () => {
    if (!scanBuffer) return;
    // Flush any pending multibyte codepoint held by the streaming decoder
    // before parsing the tail (MEDIUM #12: decode() without stream:true must
    // be called at end-of-stream/abort to emit a partial trailing codepoint).
    scanBuffer += scanDecoder.decode();
    const lines = scanBuffer.split('\n');
    scanBuffer = '';
    for (const line of lines) {
      if (!line.trim()) continue;
      parseDataLine(line.trim());
    }
  };

  const scanForBlockEvents = (value) => {
    if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) return;
    scanBuffer += scanDecoder.decode(value, { stream: true });
    if (scanBuffer.length > SCAN_BUFFER_MAX) {
      // Malformed/no-newline upstream — stop scanning rather than grow forever.
      // Keep the open-index Set intact (do NOT clear): clearing it would make
      // the abort terminal emit bare message_stop while client still has open
      // blocks → reintroduces "Content block not found" (MEDIUM #6). Overflow
      // means upstream sent garbage, but any block we did track before the
      // overflow is still legitimately open and must be closed on abort.
      scanBuffer = '';
      return;
    }
    const lines = scanBuffer.split('\n');
    // Keep the trailing (possibly incomplete) line in the buffer for the next chunk.
    scanBuffer = lines.pop() || '';
    // Only scan Claude SSE events (line starts with "data:")
    for (const line of lines) {
      parseDataLine(line.trim());
    }
  };

  // Emit a synthesized terminal payload (e.g. Responses response.failed + [DONE]) once
  const emitTerminal = (controller) => {
    if (terminalEmitted || !onAbortTerminal) return;
    terminalEmitted = true;
    try {
      // Flush any partial SSE line in the scan buffer before closing blocks,
      // so a stop that arrived mid-chunk is not missed (HIGH: truncated stop
      // would otherwise leave a stale open index → synthesized orphan stop).
      scanBuffered();
      const bytes = onAbortTerminal(openBlockIndices);
      if (bytes) controller.enqueue(bytes);
    } catch { /* best-effort terminal */ }
  };

  return new ReadableStream({
    async pull(controller) {
      if (!streamController.isConnected()) {
        emitTerminal(controller);
        controller.close();
        return;
      }

      try {
        const { done, value } = await reader.read();

        if (done) {
          streamController.handleComplete();
          controller.close();
          return;
        }
        // Only track open blocks when an abort terminal needs them (Claude /
        // Responses). Avoids pointless scanning for targets without a terminal
        // (H3: gate the scanner on the terminal builder being installed).
        if (onAbortTerminal) scanForBlockEvents(value);
        controller.enqueue(value);
      } catch (error) {
        const wasConnected = streamController.isConnected();
        // Controller already closed = downstream ended; not an upstream error, skip noisy log.
        const msg0 = error?.message || "";
        const isControllerClosed = msg0.includes("already closed") || msg0.includes("Invalid state");
        if (!isControllerClosed) streamController.handleError(error);
        reader.cancel().catch(() => {});
        writer.abort().catch(() => {});

        // Treat network resets / socket hang up / abort as graceful close
        const msg = error?.message || "";
        const code = error?.code || error?.cause?.code || "";
        const isNetworkClose =
          error.name === "AbortError" ||
          msg.includes("aborted") ||
          msg.includes("socket hang up") ||
          msg.includes("ECONNRESET") ||
          msg.includes("ETIMEDOUT") ||
          msg.includes("EPIPE") ||
          code === "ECONNRESET" ||
          code === "ETIMEDOUT" ||
          code === "EPIPE" ||
          code === "UND_ERR_SOCKET";

        // Graceful close on network/abort, or when a structured terminal is available
        // (Responses passthrough prefers response.failed + [DONE] over a raw transport error)
        try {
          if (!wasConnected || isNetworkClose || onAbortTerminal) {
            emitTerminal(controller);
            controller.close();
          } else {
            controller.error(error);
          }
        } catch (e) { /* already closed or cancelled */ }
      }
    },

    cancel(reason) {
      streamController.handleDisconnect(reason || "cancelled");
      reader.cancel();
      writer.abort();
    }
  });
}

/**
 * Pipe provider response through transform with disconnect detection.
 *
 * Stall watchdog tracks raw upstream byte activity, not transform output.
 * Reasoning models (Claude thinking via Kiro, etc.) can produce zero SSE
 * output for long stretches while partial EventStream frames keep arriving.
 * Measuring stall on the transform output caused false stalls and the
 * "failed to pipe response" error in Next.
 *
 * Any upstream chunk resets the timer. If no bytes arrive for
 * STREAM_STALL_TIMEOUT_MS, abort the underlying fetch via the controller.
 *
 * @param {Response} providerResponse - Response from provider
 * @param {TransformStream} transformStream - Transform stream for SSE
 * @param {object} streamController - Stream controller from createStreamController
 */
export function pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal = null, stallTimeoutMs = STREAM_STALL_TIMEOUT_MS) {
  let stallTimer = null;
  let chunkCount = 0;
  let totalBytes = 0;
  let lastChunkAt = Date.now();
  const t0 = Date.now();
  const tag = "STREAM";
  const clearStall = () => {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
  };
  const armStall = () => {
    clearStall();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      dbg(tag, `STALL TIMEOUT ${stallTimeoutMs}ms | chunks=${chunkCount} | bytes=${totalBytes} | sinceLast=${Date.now() - lastChunkAt}ms`);
      streamController.handleError?.(new Error("stream stall timeout"));
      streamController.abort?.();
    }, stallTimeoutMs);
  };

  // Wrap controller so every termination path clears the stall timer.
  // Without this, abort/cancel/downstream-error paths leave the timer armed
  // and a stale abort could fire after the request has already ended.
  const wrappedController = {
    signal: streamController.signal,
    startTime: streamController.startTime,
    isConnected: () => streamController.isConnected(),
    handleComplete: () => { dbg(tag, `complete | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleComplete(); },
    handleError: (e) => { dbg(tag, `error: ${e?.message} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleError(e); },
    handleDisconnect: (r) => { dbg(tag, `disconnect: ${r} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleDisconnect(r); },
    abort: () => { clearStall(); streamController.abort(); }
  };

  armStall();
  dbg(tag, `pipe start | stallTimeout=${stallTimeoutMs}ms`);

  const upstreamTap = new TransformStream({
    transform(chunk, controller) {
      chunkCount++;
      const sz = chunk?.byteLength || chunk?.length || 0;
      totalBytes += sz;
      const now = Date.now();
      const gap = now - lastChunkAt;
      lastChunkAt = now;
      if (isDebugEnabled && (chunkCount <= 5 || chunkCount % 20 === 0 || gap > 5000)) {
        dbg(tag, `chunk #${chunkCount} | size=${sz}B | gap=${gap}ms | total=${totalBytes}B`);
      }
      armStall();
      controller.enqueue(chunk);
    },
    flush() { dbg(tag, `upstream EOF | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); }
  });

  const transformedBody = providerResponse.body
    .pipeThrough(upstreamTap)
    .pipeThrough(transformStream);

  return createDisconnectAwareStream(
    { readable: transformedBody, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
    wrappedController,
    onAbortTerminal
  );
}

