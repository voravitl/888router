import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import {
  hasConnectedClients,
  BridgeJob,
  resolveAipassConversation,
  advanceAipassConversation,
  parsePart,
} from "../services/aipassBridge.js";

// Extract last user message and image parts for AiPASS upstream
function extractLastUserMessage(messages) {
  const lastUser = (messages ?? []).filter((m) => m.role === "user").at(-1);
  if (!lastUser) return { text: "", parts: [] };

  if (typeof lastUser.content === "string") {
    const text = lastUser.content.trim();
    return {
      text,
      parts: text ? [{ type: "text", text }] : [],
    };
  }

  if (Array.isArray(lastUser.content)) {
    const parts = [];
    const textPieces = [];
    for (const item of lastUser.content) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "text" && typeof item.text === "string") {
        const t = item.text.trim();
        if (t) {
          textPieces.push(t);
          parts.push({ type: "text", text: t });
        }
      } else if (item.type === "image_url") {
        const url = item.image_url?.url || item.url;
        if (typeof url === "string" && url.trim()) {
          parts.push({ type: "image", image: url.trim() });
        }
      }
    }
    return {
      text: textPieces.join("\n"),
      parts,
    };
  }

  return { text: "", parts: [] };
}

// Poll hasConnectedClients until the extension's SSE reconnects or the window
// closes. Aborting the request short-circuits the wait.
async function waitForReconnect(windowMs, pollMs, signal) {
  const deadline = Date.now() + windowMs;
  let waited = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) return waited;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    waited += pollMs;
    if (hasConnectedClients()) return waited;
  }
  return waited;
}

export class AipassExecutor extends BaseExecutor {
  constructor(config = null) {
    super("aipass", config || PROVIDERS.aipass);
    this.noAuth = true;
  }

  getProvider() {
    return "aipass";
  }

  getBaseUrls() {
    return ["bridge://aipass-hub"];
  }

  async execute({ model, body, stream, signal, log }) {
    // The hub (extension SSE) is the only transport: the old standalone-bridge
    // fallback at 127.0.0.1:8787 collided with the headroom container port and
    // ECONNREFUSED'd 502s whenever the extension's SSE was mid-reconnect.
    if (hasConnectedClients()) {
      return this.executeViaBridgeHub({ model, body, stream, signal, log });
    }

    // The extension's MV3 worker cycles its SSE every ~4 minutes; wait briefly
    // for the reconnect instead of failing the request outright.
    const RECONNECT_POLL_MS = 500;
    const RECONNECT_WINDOW_MS = 4000;
    const waited = await waitForReconnect(RECONNECT_WINDOW_MS, RECONNECT_POLL_MS, signal);
    if (hasConnectedClients()) {
      log?.info?.("AIPASS", `Extension reconnected after ${waited}ms; proceeding via hub`);
      return this.executeViaBridgeHub({ model, body, stream, signal, log });
    }

    throw new Error(
      "AiPASS Chrome extension not connected — open de.aipass.net/chat and check the bridge popup (no standalone fallback: port 8787 belongs to headroom)"
    );
  }

  async executeViaBridgeHub({ model, body, stream, signal, log }) {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    const { text, parts } = extractLastUserMessage(body.messages);
    const conversationId = await resolveAipassConversation();
    const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const created = Math.floor(Date.now() / 1000);

    if (stream) {
      const encoder = new TextEncoder();
      let aborted = false;
      let job = null;

      const readable = new ReadableStream({
        start: async (controller) => {
          if (signal?.aborted) {
            aborted = true;
            try {
              controller.close();
            } catch (_) {}
            return;
          }

          const emitDelta = (delta, finishReason = null) => {
            if (aborted) return;
            const chunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta,
                  finish_reason: finishReason,
                },
              ],
            };
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            } catch (_) {}
          };

          job = new BridgeJob({
            kind: "chat",
            modelId: model,
            text,
            parts,
            conversationId,
            aspectRatio: body.aspect_ratio || "1:1",
            onDelta: (part) => {
              const { partType, textContent, thoughtContent, fileContent } = parsePart(part);
              if (partType === "status") return;
              if (thoughtContent || partType === "thought" || partType === "reasoning") {
                if (thoughtContent) emitDelta({ reasoning_content: thoughtContent });
              } else if (fileContent || partType === "file" || partType === "image") {
                if (fileContent) emitDelta({ content: `\n![image](${fileContent})\n` });
              } else if (textContent) {
                emitDelta({ content: textContent });
              }
            },
            onDone: (finishReason) => {
              if (aborted) return;
              try {
                emitDelta({}, finishReason || "stop");
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              } catch (_) {}
            },
            onError: (err) => {
              if (aborted) return;
              const errMsg = err?.message || String(err || "Upstream error from AiPASS");
              log?.error?.("AIPASS", `Job error: ${errMsg}`);
              advanceAipassConversation();
              try {
                const errPayload = {
                  error: {
                    message: errMsg,
                    type: "upstream_error",
                  },
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(errPayload)}\n\n`));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              } catch (_) {}
            },
          });

          if (signal?.aborted) {
            aborted = true;
            job.abort();
            try {
              controller.close();
            } catch (_) {}
            return;
          }

          if (signal) {
            signal.addEventListener("abort", () => {
              aborted = true;
              job?.abort();
              try {
                controller.close();
              } catch (_) {}
            }, { once: true });
          }

          job.dispatch();
        },
        cancel() {
          aborted = true;
          job?.abort();
        },
      });

      const finalResponse = new Response(readable, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });

      return {
        response: finalResponse,
        url: "bridge://aipass-hub",
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
        transformedBody: body,
      };
    }

    // Non-streaming completion
    return new Promise((resolve, reject) => {
      let fullContent = "";
      let reasoningContent = "";
      let settled = false;

      const job = new BridgeJob({
        kind: "chat",
        modelId: model,
        text,
        parts,
        conversationId,
        aspectRatio: body.aspect_ratio || "1:1",
        onDelta: (part) => {
          if (settled) return;
          const { partType, textContent, thoughtContent, fileContent } = parsePart(part);
          if (partType === "status") return;
          if (thoughtContent) {
            reasoningContent += thoughtContent;
          }
          if (fileContent) {
            fullContent += `\n![image](${fileContent})\n`;
          } else if (textContent) {
            fullContent += textContent;
          }
        },
        onDone: (finishReason) => {
          if (settled) return;
          settled = true;
          const responsePayload = {
            id: completionId,
            object: "chat.completion",
            created,
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: fullContent,
                  ...(reasoningContent && { reasoning_content: reasoningContent }),
                },
                finish_reason: finishReason || "stop",
              },
            ],
          };
          const finalResponse = new Response(JSON.stringify(responsePayload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
          resolve({
            response: finalResponse,
            url: "bridge://aipass-hub",
            headers: { "Content-Type": "application/json" },
            transformedBody: body,
          });
        },
        onError: (err) => {
          if (settled) return;
          settled = true;
          advanceAipassConversation();
          const errMsg = err?.message || String(err || "AiPASS upstream error");
          reject(new Error(errMsg));
        },
      });

      if (signal?.aborted) {
        settled = true;
        job.abort();
        reject(new DOMException("The operation was aborted", "AbortError"));
        return;
      }

      if (signal) {
        signal.addEventListener("abort", () => {
          if (settled) return;
          settled = true;
          job.abort();
          reject(new DOMException("The operation was aborted", "AbortError"));
        }, { once: true });
      }

      job.dispatch();
    });
  }
}

export default AipassExecutor;
