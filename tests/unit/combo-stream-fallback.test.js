import { describe, it, expect, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";

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
        // Retry with raised max_tokens succeeds with real content
        if (body.max_tokens) {
          return okResponse(makeStream([
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"Retried real answer\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n",
          ]));
        }
        // Initial call: reasoning-only stream with finish length and zero content.
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

    // First model exhausted its reasoning budget (streamed) → retried once with
    // a raised max_tokens (2 calls) and succeeded with real content.
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);

    const resBody = await new Response(result.body).text();
    expect(resBody).toContain('content":"Retried real answer');
    expect(log.warn).toHaveBeenCalledWith(
      "COMBO",
      "Model oc/deepseek-v4-flash-free exhausted max_tokens on reasoning (streamed), retrying once with raised budget"
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

  it("retries once when Anthropic format SSE stream ends with stop_reason max_tokens on thinking", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const handleSingleModel = vi.fn(async (body, model) => {
      if (body.max_tokens >= 2048) {
        return okResponse(makeStream([
          "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"role\":\"assistant\",\"content\":[]}}\n\n",
          "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
          "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello from retry\"}}\n\n",
          "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
          "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        ]));
      }
      // Initial call: Anthropic format thinking only, ends with stop_reason max_tokens
      return okResponse(makeStream([
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"role\":\"assistant\",\"content\":[]}}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"thinking only\"}}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
      ]));
    });

    const result = await handleComboChat({
      body: { model: "9-deepseek-v4-flash", stream: true, max_tokens: 50, messages: [{ role: "user", content: "hi" }] },
      models: ["oc/mimo-v2.5-free"],
      handleSingleModel,
      log,
      comboName: "9-deepseek-v4-flash",
      comboStrategy: "fallback",
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    const body = await new Response(result.body).text();
    expect(body).toContain("Hello from retry");
    expect(log.warn).toHaveBeenCalledWith(
      "COMBO",
      "Model oc/mimo-v2.5-free exhausted max_tokens on reasoning (streamed), retrying once with raised budget"
    );
  });
});

describe("isReasoningEmptyContent", () => {
  it("recognizes both length and max_tokens as reasoning exhaustion when content is empty", async () => {
    const { isReasoningEmptyContent } = await import("../../open-sse/services/combo.js");

    expect(isReasoningEmptyContent("length", "", "thinking")).toBe(true);
    expect(isReasoningEmptyContent("max_tokens", "", "thinking")).toBe(true);
    expect(isReasoningEmptyContent("stop", "", "thinking")).toBe(false);
    expect(isReasoningEmptyContent("end_turn", "", "thinking")).toBe(false);
    expect(isReasoningEmptyContent("max_tokens", "some text", "thinking")).toBe(false);
    expect(isReasoningEmptyContent("max_tokens", "", "")).toBe(false);
  });
});