import { describe, it, expect, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";

const enc = (s) => new TextEncoder().encode(s);

const makeStream = (chunks) => new ReadableStream({
  start(c) { for (const ch of chunks) c.enqueue(typeof ch === "string" ? enc(ch) : ch); c.close(); },
});

const sseResponse = (chunks) => new Response(makeStream(chunks), {
  status: 200,
  headers: { "content-type": "text/event-stream" },
});

const jsonResponse = (obj) => new Response(JSON.stringify(obj), {
  status: 200,
  headers: { "content-type": "application/json" },
});

const readAll = async (res) => {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
};

describe("handleComboChat: 2xx that carries no usable answer falls through", () => {
  // Regression: the stream guard was gated on `body.stream === true`, so an
  // upstream that answers a NON-stream request with text/event-stream (opencode
  // Zen -free models do this) bypassed the guard entirely and a zero-text SSE
  // was piped to the client as a 200 with nothing in it.
  it("guards an SSE response even when the request did not ask for a stream", async () => {
    const seen = [];
    const log = { info: vi.fn(), warn: vi.fn() };

    const handleSingleModel = vi.fn(async (_body, model) => {
      seen.push(model);
      if (model === "oc/muse-spark-1.3-contributor-free") {
        // finish_reason "stop", zero content, no reasoning — not the
        // reasoning-budget signature, so this must fall through, not retry.
        return sseResponse([
          "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        ]);
      }
      return sseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"4\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n",
      ]);
    });

    const result = await handleComboChat({
      // No `stream: true` here — that is the point of the regression.
      body: { model: "9-free", messages: [{ role: "user", content: "2+2?" }] },
      models: ["oc/muse-spark-1.3-contributor-free", "oc/mimo-v2.5-free"],
      handleSingleModel,
      log,
      comboName: "9-free",
      comboStrategy: "fallback",
    });

    expect(seen).toEqual(["oc/muse-spark-1.3-contributor-free", "oc/mimo-v2.5-free"]);
    expect(result.status).toBe(200);
    expect(await readAll(result)).toContain("4");
  });

  // Regression: kilo-gateway/nvidia answers HTTP 200 while carrying the failure
  // inside the body. `result.ok` was true, so the combo returned the error
  // object to the client instead of trying the next model.
  it("falls through on HTTP 200 whose JSON body is an error envelope", async () => {
    const seen = [];
    const log = { info: vi.fn(), warn: vi.fn() };

    const handleSingleModel = vi.fn(async (_body, model) => {
      seen.push(model);
      if (model === "kgw/nvidia/nemotron-3-ultra-550b-a55b:free") {
        return jsonResponse({
          id: "gen-1",
          error: {
            message: "Upstream error from Nvidia: Service temporarily overloaded",
            code: 502,
            metadata: { error_type: "provider_unavailable" },
          },
        });
      }
      return jsonResponse({
        id: "gen-2",
        model: "stepfun/step-3.7-flash",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "42" } }],
      });
    });

    const result = await handleComboChat({
      body: { model: "9-free", messages: [{ role: "user", content: "17+25?" }] },
      models: ["kgw/nvidia/nemotron-3-ultra-550b-a55b:free", "kgw/stepfun/step-3.7-flash:free"],
      handleSingleModel,
      log,
      comboName: "9-free",
      comboStrategy: "fallback",
    });

    expect(seen).toEqual([
      "kgw/nvidia/nemotron-3-ultra-550b-a55b:free",
      "kgw/stepfun/step-3.7-flash:free",
    ]);
    expect((await result.clone().json()).choices[0].message.content).toBe("42");
  });

  it("keeps a 200 whose body has both an error field and usable choices", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const handleSingleModel = vi.fn(async () => jsonResponse({
      error: { message: "a warning that did not stop generation" },
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "still fine" } }],
    }));

    const result = await handleComboChat({
      body: { model: "9-free", messages: [{ role: "user", content: "hi" }] },
      models: ["kgw/stepfun/step-3.7-flash:free", "oc/mimo-v2.5-free"],
      handleSingleModel,
      log,
      comboName: "9-free",
      comboStrategy: "fallback",
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect((await result.clone().json()).choices[0].message.content).toBe("still fine");
  });

  it("still retries once with a raised budget on the reasoning-length signature", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const handleSingleModel = vi.fn(async (body, model) => {
      if (model === "kgw/kilo-auto/free" && !body.max_tokens) {
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking hard\"}}]}\n\n",
          "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      return sseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"answer after raise\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n",
      ]);
    });

    const result = await handleComboChat({
      body: { model: "9-free", messages: [{ role: "user", content: "hi" }] },
      models: ["kgw/kilo-auto/free", "oc/mimo-v2.5-free"],
      handleSingleModel,
      log,
      comboName: "9-free",
      comboStrategy: "fallback",
    });

    // Retried the SAME model with a raised budget rather than moving on.
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(handleSingleModel.mock.calls[1][1]).toBe("kgw/kilo-auto/free");
    expect(await readAll(result)).toContain("answer after raise");
  });
});
