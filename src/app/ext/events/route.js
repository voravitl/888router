import crypto from "crypto";
import { registerExtClient } from "open-sse/services/aipassBridge.js";
import { getExtCorsHeaders, handleExtOptions } from "@/lib/extCors.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const encoder = new TextEncoder();
  let keepAliveTimer = null;
  let unregister = null;

  const stream = new ReadableStream({
    start(controller) {
      const clientId = crypto.randomUUID();
      const client = {
        id: clientId,
        send: (event, data) => {
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch (err) {
            if (keepAliveTimer) clearInterval(keepAliveTimer);
            if (unregister) unregister();
          }
        },
        close: () => {
          try {
            controller.close();
          } catch (_) {}
        },
        unregister: () => {
          if (unregister) unregister();
        },
      };

      unregister = registerExtClient(client);

      // Heartbeat every 15s to keep extension background worker connection open
      keepAliveTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          clearInterval(keepAliveTimer);
          if (unregister) unregister();
        }
      }, 15_000);

      request.signal?.addEventListener("abort", () => {
        if (keepAliveTimer) clearInterval(keepAliveTimer);
        if (unregister) unregister();
      });
    },
    cancel() {
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      if (unregister) unregister();
    },
  });

  const corsHeaders = getExtCorsHeaders(request);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      ...corsHeaders,
    },
  });
}

export async function OPTIONS(request) {
  return handleExtOptions(request);
}
