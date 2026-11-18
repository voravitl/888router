import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    proxyAwareFetch: (...args) => mocks.proxyAwareFetch(...args),
  };
});

const { AntigravityExecutor, sanitizeAntigravityPrompt } = await import(
  "../../open-sse/executors/antigravity.js"
);
const { buildBypassResponse } = await import("../../open-sse/utils/proxyFetch.js");
const { parseUpstreamError } = await import("../../open-sse/utils/error.js");

function makeNodeIncomingMessage({ statusCode = 200, statusMessage = "OK", headers = {}, body = "" }) {
  const stream = Readable.from(body ? [Buffer.from(body)] : []);
  stream.statusCode = statusCode;
  stream.statusMessage = statusMessage;
  stream.headers = headers;
  return stream;
}

describe("sanitizeAntigravityPrompt — Hermes Agent prompt_builder.py fingerprint rewrite", () => {
  it("rewrites every blocked Hermes Agent boilerplate phrase", () => {
    const rawPrompt = [
      "You are Hermes Agent, built by Nous Research.",
      "You run on Hermes Agent (by Nous Research).",
      "For help with Hermes Agent itself, refer to docs.",
      "Be direct: match the length of your reply to the weight of the ask.",
      "Docs: https://hermes-agent.nousresearch.com/docs",
      "Remember the deliverable is a working artifact backed by real tool output.",
      "Reporting a blocker honestly is always better than inventing a result.",
      "Note: Hermes delivers their message as a standalone user message right after the latest tool results.",
      "# Google model operational directives",
      "# Hermes runtime environment",
      "OS: darwin",
      "<!-- End Hermes runtime environment -->",
    ].join("\n");

    const sanitized = sanitizeAntigravityPrompt(rawPrompt);

    expect(sanitized).toContain("You are an AI assistant.");
    expect(sanitized).toContain("You run on the local agent runtime.");
    expect(sanitized).toContain("For help with the agent runtime itself, refer to docs.");
    expect(sanitized).toContain("Be direct and match your reply length to the complexity of the request.");
    expect(sanitized).toContain("Docs: the local agent documentation");
    expect(sanitized).toContain("Remember the deliverable is a verified working result backed by real tool output.");
    expect(sanitized).toContain("Reporting a blocker honestly is always preferable to fabricating a result.");
    expect(sanitized).toContain("Note: the runtime delivers their message as a standalone user message right after the latest tool results.");
    expect(sanitized).toContain("# Model operational directives");
    expect(sanitized).toContain("# Runtime environment");
    expect(sanitized).toContain("<!-- End runtime environment -->");

    for (const blocked of [
      "Hermes Agent",
      "Nous Research",
      "hermes-agent.nousresearch.com",
      "weight of the ask",
      "working artifact backed by real tool output",
      "better than inventing a result",
      "Hermes delivers their message",
      "Google model operational directives",
      "Hermes runtime environment",
    ]) {
      expect(sanitized.toLowerCase()).not.toContain(blocked.toLowerCase());
    }
  });

  it("rewrites short Hermes variants without optional company parentheticals", () => {
    expect(sanitizeAntigravityPrompt("You are Hermes Agent. Ready.")).toBe("You are an AI assistant. Ready.");
    expect(sanitizeAntigravityPrompt("You run on Hermes Agent.")).toBe("You run on the local agent runtime.");
    expect(sanitizeAntigravityPrompt(null)).toBeNull();
    expect(sanitizeAntigravityPrompt(undefined)).toBeUndefined();
  });

  it("applies Hermes sanitization inside AntigravityExecutor.transformRequest systemInstruction", () => {
    const ag = new AntigravityExecutor();
    const out = ag.transformRequest(
      "gemini-4-hydrogen-low",
      {
        request: {
          systemInstruction: {
            parts: [{ text: "You are Hermes Agent, built by Nous Research.\n# Google model operational directives" }],
          },
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        },
      },
      true,
      { projectId: "proj-1" },
    );

    const rewritten = out.request.systemInstruction.parts[0].text;
    expect(rewritten).toBe("You are an AI assistant.\n# Model operational directives");
  });
});

describe("AntigravityExecutor.computeRetryDelay — clone-less response support", () => {
  const ag = new AntigravityExecutor();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("vetoes retry immediately (false) on 429 RESOURCE_EXHAUSTED when response lacks .clone() and has a ReadableStream body", async () => {
    const payload = JSON.stringify({
      error: {
        code: 429,
        message: "Resource has been exhausted (e.g. check quota).",
        status: "RESOURCE_EXHAUSTED",
      },
    });
    const streamResponse = {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: new Map([["content-type", "application/json"]]),
      body: new Response(payload).body,
      text: async () => payload,
    };

    expect(await ag.computeRetryDelay(streamResponse, 1)).toBe(false);
    // Body remains readable for downstream parseUpstreamError!
    expect(await new Response(streamResponse.body).text()).toBe(payload);
  });

  it("vetoes retry immediately on 429 RESOURCE_EXHAUSTED when response has only .text() and lacks .clone()", async () => {
    const payload = JSON.stringify({
      error: {
        code: 429,
        message: "Resource has been exhausted (e.g. check quota).",
        status: "RESOURCE_EXHAUSTED",
      },
    });
    const textOnlyResponse = {
      ok: false,
      status: 429,
      headers: { get: () => null },
      text: async () => payload,
    };

    expect(await ag.computeRetryDelay(textOnlyResponse, 1)).toBe(false);
  });

  it("execute() makes only 1 upstream hit (0 retries) and preserves error body for parseUpstreamError on clone-less 429", async () => {
    const payload = JSON.stringify({
      error: {
        code: 429,
        message: "Resource has been exhausted (e.g. check quota).",
        status: "RESOURCE_EXHAUSTED",
      },
    });
    const backingStream = new Response(payload).body;
    const clonelessBypass = {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: new Map([["content-type", "application/json"]]),
      body: backingStream,
      text: async () => {
        throw new Error("should not drain underlying stream before tee");
      },
    };
    mocks.proxyAwareFetch.mockResolvedValueOnce(clonelessBypass);

    const out = await ag.execute({
      model: "gemini-4-hydrogen-low",
      body: { request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } },
      stream: false,
      credentials: { accessToken: "tok", projectId: "proj-1" },
    });

    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(out.response.status).toBe(429);

    const parsed = await parseUpstreamError(out.response, ag);
    expect(parsed.statusCode).toBe(429);
    expect(parsed.message).toContain("Resource has been exhausted");
  });
});

describe("proxyFetch bypass response .clone() and Node header support", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("dns");
    vi.doUnmock("net");
    vi.doUnmock("https");
    vi.doUnmock("../../open-sse/utils/proxyFetch.js");
  });

  it("buildBypassResponse supports .clone(), case-insensitive .headers.get(), and set-cookie arrays", async () => {
    const payload = JSON.stringify({
      error: { code: 429, message: "Resource has been exhausted", status: "RESOURCE_EXHAUSTED" },
    });
    const incoming = makeNodeIncomingMessage({
      statusCode: 429,
      statusMessage: "Too Many Requests",
      headers: {
        "content-type": "application/json",
        "retry-after": "120",
        "set-cookie": ["a=1; Path=/", "b=2; HttpOnly"],
      },
      body: payload,
    });

    const resp = buildBypassResponse(incoming);
    expect(resp.ok).toBe(false);
    expect(resp.status).toBe(429);
    expect(resp.statusText).toBe("Too Many Requests");
    expect(typeof resp.clone).toBe("function");
    expect(resp.headers.get("content-type")).toBe("application/json");
    expect(resp.headers.get("Content-Type")).toBe("application/json");
    expect(resp.headers.get("Retry-After")).toBe("120");
    expect(resp.headers.get("set-cookie")).toContain("a=1");
    expect(resp.headers.get("set-cookie")).toContain("b=2");

    const clonedText = await resp.clone().text();
    const primaryText = await resp.text();
    expect(clonedText).toBe(payload);
    expect(primaryText).toBe(payload);
  });

  it("buildBypassResponse handles 204 null-body status cleanly with .clone()", async () => {
    const incoming = makeNodeIncomingMessage({
      statusCode: 204,
      statusMessage: "No Content",
      headers: { "x-test": "yes" },
      body: "",
    });
    const resp = buildBypassResponse(incoming);
    expect(resp.ok).toBe(true);
    expect(resp.status).toBe(204);
    expect(resp.body).toBeNull();
    expect(typeof resp.clone).toBe("function");
    expect(await resp.clone().text()).toBe("");
    expect(resp.headers.get("X-Test")).toBe("yes");
  });

  it("createBypassRequest via proxyAwareFetch returns a cloneable 429 response for MITM bypass hosts", async () => {
    const payload = JSON.stringify({
      error: { code: 429, message: "Resource has been exhausted", status: "RESOURCE_EXHAUSTED" },
    });
    const savedEnv = {
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      https_proxy: process.env.https_proxy,
      ALL_PROXY: process.env.ALL_PROXY,
      all_proxy: process.env.all_proxy,
    };
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.ALL_PROXY;
    delete process.env.all_proxy;

    try {
      vi.resetModules();
      vi.doUnmock("../../open-sse/utils/proxyFetch.js");
      vi.doMock("dns", () => ({
        Resolver: class {
          setServers() {}
          resolve4(_host, cb) { cb(null, ["142.250.1.1"]); }
        },
      }));
      vi.doMock("net", () => ({
        default: {
          Socket: class extends EventEmitter {
            connect(_port, _ip, cb) { cb(); }
          },
        },
      }));
      vi.doMock("https", () => ({
        default: {
          request: (_opts, onRes) => {
            const req = new EventEmitter();
            req.write = () => {};
            req.end = () => {
              const incoming = makeNodeIncomingMessage({
                statusCode: 429,
                statusMessage: "Too Many Requests",
                headers: {
                  "content-type": "application/json",
                  "set-cookie": ["k1=v1", "k2=v2"],
                },
                body: payload,
              });
              onRes(incoming);
            };
            return req;
          },
        },
      }));

      const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
      const resp = await proxyAwareFetch("https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      expect(resp.status).toBe(429);
      expect(typeof resp.clone).toBe("function");
      expect(resp.headers.get("Content-Type")).toBe("application/json");
      expect(resp.headers.get("set-cookie")).toContain("k1=v1");
      expect(resp.headers.get("set-cookie")).toContain("k2=v2");
      expect(await resp.clone().text()).toBe(payload);
      expect(await resp.text()).toBe(payload);
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
