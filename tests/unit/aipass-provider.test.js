import { describe, expect, it, vi, beforeEach } from "vitest";
import aipassConfig from "../../open-sse/providers/registry/aipass.js";
import { isPublicModelsProvider } from "../../src/shared/constants/providers.js";
import {
  decodeTurboStream,
  kindOf,
  registerExtClient,
  hasConnectedClients,
  getClientCount,
  parsePart,
  createBridgeJob,
  handleExtChunk,
  handleExtDone,
  handleExtLoader,
  createAipassConversation,
} from "../../open-sse/services/aipassBridge.js";
import { AipassExecutor } from "../../open-sse/executors/aipass.js";
import { getAipassUsage } from "../../open-sse/services/usage/aipass.js";

const mockProxyAwareFetch = vi.fn(async (url) => {
  if (url.includes("/quota")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        creditStatus: {
          periodEndsAt: "2026-09-30T23:59:59Z",
          creditsDecimals: 6,
          credits: {
            limit: "10000000000",
            used: "1500000000",
            available: "8500000000",
          },
        },
      }),
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: "chatcmpl-standalone",
      choices: [{ message: { role: "assistant", content: "Standalone bridge reply" } }],
    }),
  };
});

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => mockProxyAwareFetch(...args),
}));

describe("AiPASS TH Provider & Bridge Test Suite", () => {
  beforeEach(() => {
    mockProxyAwareFetch.mockClear();
    if (globalThis.__AIPASS_BRIDGE__) {
      globalThis.__AIPASS_BRIDGE__.jobs.clear();
      globalThis.__AIPASS_BRIDGE__.extClients.clear();
      globalThis.__AIPASS_BRIDGE__.roundRobinIndex = 0;
      globalThis.__AIPASS_BRIDGE__.conversationCache = null;
      globalThis.__AIPASS_BRIDGE__.conversationList = [];
      globalThis.__AIPASS_BRIDGE__.conversationIndex = 0;
      globalThis.__AIPASS_BRIDGE__.modelCache = { at: 0, models: [] };
    }
  });

  it("provides correct metadata and models in aipass registry", () => {
    expect(aipassConfig.id).toBe("aipass");
    expect(aipassConfig.hasFree).toBe(true);
    expect(aipassConfig.noAuth).toBe(true);
    expect(aipassConfig.category).toBe("freeTier");
    expect(aipassConfig.aliases).toContain("aipass-th");
    expect(aipassConfig.aliases).toContain("aipass-bridge");
    expect(aipassConfig.aliases).toContain("ap");

    const modelIds = aipassConfig.models.map((m) => m.id);
    expect(modelIds).toContain("gemini-3.1-flash-lite");
    expect(modelIds).toContain("claude-sonnet-5@default");
    expect(modelIds).toContain("gpt-image-2");
  });

  it("identifies aipass and its aliases as public models providers", () => {
    expect(isPublicModelsProvider("aipass")).toBe(true);
    expect(isPublicModelsProvider("aipass-th")).toBe(true);
    expect(isPublicModelsProvider("aipass-bridge")).toBe(true);
    expect(isPublicModelsProvider("ap")).toBe(true);
  });

  it("classifies models into proper kinds (chat, image, video, music, research)", () => {
    expect(kindOf("claude-sonnet-5@default")).toBe("chat");
    expect(kindOf("gemini-3.1-flash-lite")).toBe("chat");
    expect(kindOf("gpt-image-2")).toBe("image");
    expect(kindOf("gemini-3-pro-image")).toBe("image");
    expect(kindOf("veo-3.1-fast-generate-001")).toBe("video");
    expect(kindOf("lyria-3-pro-preview")).toBe("music");
    expect(kindOf("sonar-deep-research")).toBe("research");
  });

  it("decodes turbo-stream React Router loader format correctly", () => {
    const flatPool = [
      { _1: 2 },
      "routes/loaders/list-models",
      { _3: 4 },
      "data",
      { _5: 6 },
      "models",
      [7],
      { _8: 9, _10: 11 },
      "id",
      "gemini-3.1-flash-lite",
      "name",
      "Gemini 3.1 Flash Lite",
    ];

    const decoded = decodeTurboStream(JSON.stringify(flatPool));
    expect(decoded).toBeTruthy();
    expect(decoded["routes/loaders/list-models"]?.data?.models?.[0]?.id).toBe("gemini-3.1-flash-lite");
    expect(decoded["routes/loaders/list-models"]?.data?.models?.[0]?.name).toBe("Gemini 3.1 Flash Lite");
  });

  it("parses both kind and type schemas in delta parts", () => {
    expect(parsePart({ kind: "text", text: "hello" })).toEqual({
      partType: "text",
      textContent: "hello",
      thoughtContent: "",
      fileContent: "",
    });

    expect(parsePart({ kind: "thought", thought: "thinking..." })).toEqual({
      partType: "thought",
      textContent: "",
      thoughtContent: "thinking...",
      fileContent: "",
    });

    expect(parsePart({ type: "image", url: "https://example.com/img.png" })).toEqual({
      partType: "image",
      textContent: "",
      thoughtContent: "",
      fileContent: "https://example.com/img.png",
    });
  });

  it("manages extension client registration and event handling", () => {
    const sentEvents = [];
    const fakeClient = {
      id: "client-test-1",
      send: (event, data) => sentEvents.push({ event, data }),
    };

    const unregister = registerExtClient(fakeClient);
    expect(hasConnectedClients()).toBe(true);
    expect(getClientCount()).toBeGreaterThanOrEqual(1);
    expect(sentEvents[0]?.event).toBe("ready");
    expect(sentEvents[0]?.data?.clientId).toBe("client-test-1");

    unregister();
    expect(hasConnectedClients()).toBe(false);
  });

  it("conforms AipassExecutor return contract: { response, url, headers, transformedBody }", async () => {
    const executor = new AipassExecutor();

    const result = await executor.execute({
      model: "claude-sonnet-5@default",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials: {},
      signal: null,
    });

    expect(result).toHaveProperty("response");
    expect(result).toHaveProperty("url");
    expect(result).toHaveProperty("headers");
    expect(result).toHaveProperty("transformedBody");
    expect(result.response.status).toBe(200);

    const data = await result.response.json();
    expect(data.choices[0].message.content).toBe("Standalone bridge reply");
    expect(mockProxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("http://127.0.0.1:8787/v1/chat/completions"),
      expect.objectContaining({ method: "POST" }),
      null
    );
  });

  it("aborts BridgeJob when abort signal is triggered", async () => {
    let capturedError = null;
    const job = createBridgeJob({
      model: "gemini-3.1-flash-lite",
      messages: [{ role: "user", content: "test" }],
      stream: false,
      onError: (err) => {
        capturedError = err;
      },
    });

    job.abort();
    expect(capturedError?.message).toMatch(/job aborted/i);
    expect(job.settled).toBe(true);
  });

  it("dispatches job to connected extension client without ReferenceError", () => {
    const receivedEvents = [];
    const client = {
      id: "client-dispatch-test",
      send: (event, data) => receivedEvents.push({ event, data }),
    };

    const unregister = registerExtClient(client);
    try {
      const job = createBridgeJob({
        kind: "chat",
        modelId: "gemini-3.1-flash-lite",
        text: "hello from antigravity",
        conversationId: "conv-12345",
      });

      job.dispatch();
      expect(receivedEvents).toHaveLength(2); // ready + job
      expect(receivedEvents[1].event).toBe("job");
      expect(receivedEvents[1].data.modelId).toBe("gemini-3.1-flash-lite");
      expect(receivedEvents[1].data.text).toBe("hello from antigravity");
      expect(receivedEvents[1].data.conversationId).toBe("conv-12345");
      job.cleanup();
    } finally {
      unregister();
    }
  });

  it("executes non-streaming request via bridge hub with chunk collection", async () => {
    let activeJobId = null;
    const client = {
      id: "client-exec-test",
      send: (event, data) => {
        if (event === "job") {
          const { jobId, kind } = data;
          if (kind === "loader") {
            setTimeout(() => {
              handleExtLoader({
                jobId,
                raw: "[]",
              });
            }, 5);
          } else if (kind === "create") {
            setTimeout(() => {
              handleExtLoader({
                jobId,
                raw: JSON.stringify([{ conversationId: "conv-1234567890123456" }]),
              });
            }, 5);
          } else if (kind === "chat") {
            setTimeout(() => {
              handleExtChunk({
                jobId,
                part: { kind: "thought", thought: "Thinking deeply..." },
              });
              handleExtChunk({
                jobId,
                part: { kind: "text", text: "Hub answer text" },
              });
              handleExtDone({
                jobId,
                finishReason: "stop",
              });
            }, 5);
          }
        }
      },
    };

    const unregister = registerExtClient(client);
    try {
      const executor = new AipassExecutor();
      const result = await executor.execute({
        model: "gemini-3.1-flash-lite",
        body: { messages: [{ role: "user", content: "test hub execute" }] },
        stream: false,
        credentials: {},
        signal: null,
      });

      expect(result.url).toBe("bridge://aipass-hub");
      expect(result.response.status).toBe(200);
      const data = await result.response.json();
      expect(data.choices[0].message.content).toBe("Hub answer text");
      expect(data.choices[0].message.reasoning_content).toBe("Thinking deeply...");
    } finally {
      unregister();
    }
  });

  it("evicts oldest client and fails associated jobs when exceeding MAX_EXT_CLIENTS", () => {
    const unregisterList = [];
    let failedReason = null;

    const client1 = {
      id: "client-1",
      send: () => {},
      close: vi.fn(),
    };
    unregisterList.push(registerExtClient(client1));

    const job = createBridgeJob({
      kind: "chat",
      modelId: "gemini-3.1-flash-lite",
      text: "test eviction",
      onError: (err) => {
        failedReason = err?.message || String(err);
      },
    });
    job.dispatch();

    for (let i = 2; i <= 11; i++) {
      unregisterList.push(registerExtClient({
        id: `client-${i}`,
        send: () => {},
        close: vi.fn(),
      }));
    }

    expect(client1.close).toHaveBeenCalled();
    expect(failedReason).toMatch(/client disconnected due to connection pool limit/i);

    unregisterList.forEach((u) => u());
  });

  it("fails createAipassConversation when upstream returns invalid or missing conversationId or model object", async () => {
    const client = {
      id: "client-invalid-create",
      send: (event, data) => {
        if (event === "job" && data.kind === "create") {
          setTimeout(() => {
            handleExtLoader({
              jobId: data.jobId,
              raw: JSON.stringify([
                { id: "claude-sonnet-5@default", name: "Claude Sonnet 5", provider: "anthropic" },
                { id: "gemini-3-pro-image", name: "Gemini 3 Pro Image" },
              ]),
            });
          }, 5);
        }
      },
    };

    const unregister = registerExtClient(client);
    try {
      await expect(createAipassConversation()).rejects.toThrow(/Could not read valid conversationId/i);
    } finally {
      unregister();
    }
  });

  it("processes kind: thought with text field through AipassExecutor without dropping reasoning", async () => {
    const client = {
      id: "client-thought-test",
      send: (event, data) => {
        if (event === "job") {
          const { jobId, kind } = data;
          if (kind === "loader") {
            setTimeout(() => handleExtLoader({ jobId, raw: "[]" }), 5);
          } else if (kind === "create") {
            setTimeout(() => handleExtLoader({ jobId, raw: JSON.stringify([{ conversationId: "conv-1234567890123456" }]) }), 5);
          } else if (kind === "chat") {
            setTimeout(() => {
              handleExtChunk({
                jobId,
                part: { kind: "thought", text: "secret thought" },
              });
              handleExtChunk({
                jobId,
                part: { kind: "text", text: "final answer" },
              });
              handleExtDone({ jobId, finishReason: "stop" });
            }, 5);
          }
        }
      },
    };

    const unregister = registerExtClient(client);
    try {
      const executor = new AipassExecutor();
      const result = await executor.execute({
        model: "gemini-3.1-flash-lite",
        body: { messages: [{ role: "user", content: "test thought" }] },
        stream: false,
        credentials: {},
        signal: null,
      });

      const data = await result.response.json();
      expect(data.choices[0].message.content).toBe("final answer");
      expect(data.choices[0].message.reasoning_content).toBe("secret thought");
    } finally {
      unregister();
    }
  });

  it("aborts BridgeJob and notifies client when ReadableStream.cancel() is triggered", async () => {
    let capturedJobId = null;
    let abortReceived = false;
    const client = {
      id: "client-stream-cancel-test",
      send: (event, data) => {
        if (event === "job") {
          const { jobId, kind } = data;
          capturedJobId = jobId;
          if (kind === "loader") {
            setTimeout(() => handleExtLoader({ jobId, raw: "[]" }), 5);
          } else if (kind === "create") {
            setTimeout(() => handleExtLoader({ jobId, raw: JSON.stringify([{ conversationId: "conv-1234567890123456" }]) }), 5);
          }
          // Do not send finish for chat so job remains active
        } else if (event === "abort" && data?.jobId === capturedJobId) {
          abortReceived = true;
        }
      },
    };

    const unregister = registerExtClient(client);
    try {
      const executor = new AipassExecutor();
      const result = await executor.execute({
        model: "gemini-3.1-flash-lite",
        body: { messages: [{ role: "user", content: "stream cancel test" }] },
        stream: true,
        credentials: {},
        signal: null,
      });

      expect(result.response.status).toBe(200);
      const reader = result.response.body.getReader();
      // Cancel the readable stream from client side
      await reader.cancel("client disconnected");

      // Verify that the client received the abort event and job is settled
      expect(abortReceived).toBe(true);
      const remainingJobs = [...(globalThis.__AIPASS_BRIDGE__?.jobs?.values() || [])];
      expect(remainingJobs.every((j) => j.settled)).toBe(true);
    } finally {
      unregister();
    }
  });

  it("handles pre-aborted signal in both streaming and non-streaming modes", async () => {
    const client = { id: "client-pre-abort", send: () => {} };
    const unregister = registerExtClient(client);
    try {
      const preAbortedSignal = AbortSignal.abort();
      const executor = new AipassExecutor();

      // Streaming pre-aborted
      await expect(
        executor.execute({
          model: "gemini-3.1-flash-lite",
          body: { messages: [{ role: "user", content: "pre-aborted stream" }] },
          stream: true,
          credentials: {},
          signal: preAbortedSignal,
        })
      ).rejects.toThrow(/aborted/i);

      // Non-streaming pre-aborted
      await expect(
        executor.execute({
          model: "gemini-3.1-flash-lite",
          body: { messages: [{ role: "user", content: "pre-aborted non-stream" }] },
          stream: false,
          credentials: {},
          signal: preAbortedSignal,
        })
      ).rejects.toThrow(/aborted/i);
    } finally {
      unregister();
    }
  });

  it("parses quota and credit status from loader JSON", async () => {
    const usage = await getAipassUsage("dummy", {});
    expect(usage.plan).toBe("AiPASS Citizen Free");
    expect(usage.quotas.credits.total).toBe(10000);
    expect(usage.quotas.credits.used).toBe(1500);
    expect(usage.quotas.credits.remainingPercentage).toBe(85);
  });
});
