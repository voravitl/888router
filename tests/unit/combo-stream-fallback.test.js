import { describe, it, expect, vi } from "vitest";
import { handleComboChat } from "../open-sse/services/combo.js";

const enc = (s) => new TextEncoder().encode(s);

const makeStream = (chunks) => new ReadableStream({
  start(c) { for (const ch of chunks) c.enqueue(typeof ch === "string" ? enc(ch) : ch); c.close(); },
});

const okResponse = (respBody, headers = {}) => new Response(respBody, {
  status: 200,
  headers: { "content-type": "text/event-stream", ...headers },
});

describe("handleComboChat empty-stream fallback", () => {
  it("falls through when the first model streams empty (reasoning-length) and second model replies", async () => {
    const seen = [];
    const log = { info: vi.fn(), warn: vi.fn() };

    const handleSingleModel = vi.fn(async (body, model) => {
      seen.push(model);
      if (model === "oc/deepseek-v4-flash-free") {
        // Reasoning-only stream with finish length and zero content.
        return okResponse(makeStream([
          "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"deep thinking\"}}]}\n\n",
          "data: {\"choices\":[{\"delta\":{\"content\":\"\"},\"finish_reason\":\"length\"}]}\n\n",
          "data: [DONE]\n\n",
        ]));
      }
      if (model === "ollama/deepseek-v4-flash") {
        // Real content.
        return okResponse(makeStream([
          "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"Real answer body\"}}]}\n\n",
          "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
          "data: [DONE]\n\n",
        ]));
      }
      return okResponse(makeStream([]));
    });

    const result = await handleComboChat({
      body: { model: "9-deepseek-v4-flash", stream: true, messages: [{ role: "user", content: "hi" }] },
      models: ["oc/deepseek-v4-flash-free", "ollama/deepseek-v4-flash"],
      handleSingleModel,
      log,
      comboName: "9-deepseek-v4-flash",
      comboStrategy: "fallback",
    });

    // First model was rejected (empty), second answered.
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);

    const body = await new Response(result.body).text();
    expect(body).toContain('content":"Real answer body');
    expect(log.warn).toHaveBeenCalledWith(
      "COMBO",
      "Model oc/deepseek-v4-flash-free returned 200 SSE stream with zero text content, trying next"
    );
  });

  it("passes through immediately when the first model streams real content", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const handleSingleModel = vi.fn(async () =>
      okResponse(makeStream([
        "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"Good\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\" answer\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n",
      ]))
    );

    const result = await handleComboChat({
      body: { messages: [], stream: true },
      models: ["oc/deepseek-v4-flash-free"],
      handleSingleModel,
      log,
      comboName: "x",
      comboStrategy: "fallback",
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    const body = await new Response(result.body).text();
    expect(body).toContain('content":"Good');
    expect(body).toContain('content":" answer');
    expect(body).toContain("[DONE]");
  });
});