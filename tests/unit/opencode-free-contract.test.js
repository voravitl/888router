import { beforeEach, describe, expect, it, vi } from "vitest";

// OpenCode Zen FREE lane request contract + transport selection.
//
// Evidence (scratch probe/report.md, 2026-10-29, 4 live anonymous requests to
// /zen/v1/chat/completions, deepseek-v4.1-flash-free):
//   native fetch + upstream v2 contract        -> 429 FreeUsageLimitError
//   wreq-js cipher-list TLS + v2 contract      -> 200 (twice)
//   wreq-js TLS + OUR previous v1 request      -> 429
// So the free lane needs BOTH the impersonated transport and the v2
// header/body contract; opencode-go and paid Zen must stay as they were.
// Network is never touched: proxyAwareFetch is mocked.

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetchMock }));

import { OpenCodeExecutor, __test__ as ocTest } from "../../open-sse/executors/opencode.js";
import { restoreOpencodeToolNames } from "../../open-sse/utils/opencodeToolSanitizer.js";

const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const FREE = "deepseek-v4.1-flash-free";

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
});

async function run(provider, model, body, credentials = {}) {
  const ex = new OpenCodeExecutor(provider);
  const result = await ex.execute({ model, body, stream: true, credentials: { rawHeaders: {}, ...credentials } });
  const [url, init] = fetchMock.mock.calls.at(-1);
  return { result, url, init, sent: JSON.parse(init.body) };
}

function names(tools) {
  return (tools || []).map((t) => t.function?.name || t.name);
}

describe("free lane transport", () => {
  it("routes oc/*-free through the impersonated TLS client (directFetch + directFetchProxy)", async () => {
    const { init } = await run("opencode", FREE, { messages: [{ role: "user", content: "hi" }] });
    expect(typeof init.directFetch).toBe("function");
    expect(init.directFetchProxy).toBe(true);
  });

  it("covers big-pickle and thinking-suffixed free ids", async () => {
    for (const model of ["big-pickle", `${FREE}(high)`]) {
      const { init } = await run("opencode", model, { messages: [{ role: "user", content: "hi" }] });
      expect(typeof init.directFetch).toBe("function");
    }
  });

  it("does NOT use directFetch for opencode-go", async () => {
    const { init } = await run("opencode-go", "deepseek-v4-pro", { messages: [{ role: "user", content: "hi" }] }, { apiKey: "sk-go" });
    expect("directFetch" in init).toBe(false);
    expect("directFetchProxy" in init).toBe(false);
  });

  it("does NOT use directFetch for a paid Zen model", async () => {
    const { init } = await run("opencode", "glm-5.2", { messages: [{ role: "user", content: "hi" }] }, { apiKey: "sk-zen" });
    expect("directFetch" in init).toBe(false);
  });
});

describe("free lane headers (OpenCode v2 CLI contract)", () => {
  it("sends the v2 UA, cli client and the four session headers, never x-opencode-request", async () => {
    const { init } = await run("opencode", FREE, { messages: [{ role: "user", content: "hi" }] });
    const h = init.headers;
    expect(h["User-Agent"]).toBe("opencode/latest/2.0.26/cli");
    expect(h["x-opencode-client"]).toBe("cli");
    expect(h["x-opencode-session"]).toMatch(SESSION_RE);
    for (const k of ["x-opencode-session-id", "x-session-affinity", "x-session-id"]) {
      expect(h[k]).toBe(h["x-opencode-session"]);
    }
    expect(h["x-opencode-request"]).toBeUndefined();
    expect(h["x-opencode-project"]).toBe("global");
    expect(h.Authorization).toBe("Bearer public");
    expect(h.Accept).toBe("text/event-stream");
  });

  it("keeps a genuine v2 downstream UA but replaces a v1 one", () => {
    const ex = new OpenCodeExecutor();
    const v2 = ex.buildHeaders({ rawHeaders: { "user-agent": "opencode/latest/2.1.0/cli" } }, true, "", FREE);
    expect(v2["User-Agent"]).toBe("opencode/latest/2.1.0/cli");
    const v1 = ex.buildHeaders({ rawHeaders: { "user-agent": "opencode/1.18.31" } }, true, "", FREE);
    expect(v1["User-Agent"]).toBe("opencode/latest/2.0.26/cli");
  });

  it("leaves opencode-go headers on the previous contract", () => {
    const ex = new OpenCodeExecutor("opencode-go");
    const h = ex.buildHeaders({ apiKey: "sk-go", rawHeaders: {} }, true, "", "deepseek-v4-pro");
    expect(h["User-Agent"]).toBe("opencode/1.18.31");
    expect(h["x-opencode-client"]).toBe("desktop");
    expect(h["x-opencode-request"]).toMatch(/^msg_/);
    expect(h["x-opencode-session-id"]).toBeUndefined();
    expect(h.Authorization).toBe("Bearer sk-go");
  });

  it("leaves paid Zen headers on the previous contract", () => {
    const ex = new OpenCodeExecutor();
    const h = ex.buildHeaders({ apiKey: "sk-zen", rawHeaders: {} }, true, "", "glm-5.2");
    expect(h["User-Agent"]).toBe("opencode/1.18.31");
    expect(h["x-opencode-client"]).toBe("desktop");
    expect(h["x-opencode-request"]).toMatch(/^msg_/);
  });
});

describe("free lane body contract", () => {
  it("chat: adds the <env> marker and the exact read/shell tools (no bash/glob/grep stubs)", async () => {
    const { sent } = await run("opencode", FREE, { messages: [{ role: "user", content: "hi" }] });
    expect(sent.stream).toBe(true);
    const sys = sent.messages.find((m) => m.role === "system");
    expect(sys.content).toContain("<env>");
    expect(sys.content).toContain("</env>");
    expect(names(sent.tools).sort()).toEqual(["read", "shell"]);
    const read = sent.tools.find((t) => t.function.name === "read").function;
    expect(read.description.startsWith("Read the contents of a file or directory.")).toBe(true);
    expect(read.parameters.required).toEqual(["path"]);
    for (const stub of ["bash", "glob", "grep"]) expect(names(sent.tools)).not.toContain(stub);
    expect(JSON.stringify(sent)).not.toContain("OpenCode built-in");
  });

  it("chat: appends the marker to an existing system prompt instead of replacing it", async () => {
    const { sent } = await run("opencode", FREE, {
      messages: [{ role: "system", content: "You are terse." }, { role: "user", content: "hi" }],
    });
    const sys = sent.messages.filter((m) => m.role === "system");
    expect(sys).toHaveLength(1);
    expect(sys[0].content.startsWith("You are terse.")).toBe(true);
    expect(sys[0].content).toContain("<env>");
  });

  it("Responses: carries the marker in instructions with flat read/shell tools", async () => {
    const { sent, url } = await run("opencode", "muse-spark-1.3-contributor-free", {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      instructions: "Be brief.",
    });
    expect(url).toBe("https://opencode.ai/zen/v1/responses");
    expect(sent.instructions.startsWith("Be brief.")).toBe(true);
    expect(sent.instructions).toContain("<env>");
    expect(names(sent.tools).sort()).toEqual(["read", "shell"]);
    expect(sent.tools.every((t) => t.type === "function" && !t.function)).toBe(true);
    expect(sent.tool_choice).toBe("auto");
  });

  it("claude /messages: carries the marker in top-level system with input_schema tools", () => {
    // A claude-format model on the free lane (no claude-format model is free
    // today; the shape is still honoured so one appearing does not 429).
    const out = ocTest.applyFreeLaneContract(
      { system: [{ type: "text", text: "sys" }], messages: [{ role: "user", content: "hi" }] },
      "claude",
    );
    expect(out.body.system.at(-1).text).toContain("<env>");
    expect(out.body.system[0].text.startsWith("sys")).toBe(true);
    expect(out.body.messages.some((m) => m.role === "system")).toBe(false);
    expect(out.body.tools.every((t) => t.input_schema && !t.function)).toBe(true);
    expect(names(out.body.tools).sort()).toEqual(["read", "shell"]);
  });

  it("is idempotent across executor retries (same body, same output)", () => {
    const ex = new OpenCodeExecutor();
    const body = { messages: [{ role: "user", content: "hi" }] };
    const a = ex.transformRequest(FREE, body, true, {});
    const b = ex.transformRequest(FREE, body, true, {});
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(body.messages).toHaveLength(1);
    expect(body.tools).toBeUndefined();
  });

  it("does not touch opencode-go / paid Zen bodies (no marker, no tools)", async () => {
    for (const [provider, model, creds] of [["opencode-go", "deepseek-v4-pro", { apiKey: "sk-go" }], ["opencode", "glm-5.2", { apiKey: "sk-zen" }]]) {
      const { sent } = await run(provider, model, { messages: [{ role: "user", content: "hi" }] }, creds);
      expect(sent.tools).toBeUndefined();
      expect(JSON.stringify(sent)).not.toContain("<env>");
    }
  });
});

describe("caller tools that collide with read/shell", () => {
  const callerRead = {
    type: "function",
    function: {
      name: "read",
      description: "Read a URL",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  };

  it("aliases a caller `read` with a different schema and restores it via the existing _toolNameMap", async () => {
    const { result, sent } = await run("opencode", FREE, {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{\"url\":\"x\"}" } }] },
        { role: "tool", tool_call_id: "c1", content: "ok" },
      ],
      tools: [callerRead],
      tool_choice: { type: "function", function: { name: "read" } },
    });
    const sentNames = names(sent.tools);
    expect(sentNames).toContain("read_client");
    expect(sentNames).toContain("read");
    expect(sentNames).toContain("shell");
    const fingerprintRead = sent.tools.find((t) => t.function.name === "read").function;
    expect(fingerprintRead.parameters.required).toEqual(["path"]);
    expect(sent.tool_choice.function.name).toBe("read_client");
    expect(sent.messages.find((m) => m.tool_calls)?.tool_calls[0].function.name).toBe("read_client");
    expect(sent._toolNameMap).toBeUndefined();

    expect(result.toolNameMap).toBeInstanceOf(Map);
    expect(result.toolNameMap.get("read_client")).toBe("read");
    const upstreamChunk = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "t", function: { name: "read_client", arguments: "" } }] } }] };
    const restored = restoreOpencodeToolNames(upstreamChunk, result.toolNameMap);
    expect(restored.choices[0].delta.tool_calls[0].function.name).toBe("read");
  });

  it("aliases a Responses caller `shell` with an incompatible schema and restores output items", async () => {
    const { result, sent } = await run("opencode", "muse-spark-1.3-contributor-free", {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [{ type: "function", name: "shell", description: "Run", parameters: { type: "object", properties: { argv: { type: "array" } }, required: ["argv"] } }],
    });
    expect(names(sent.tools)).toEqual(expect.arrayContaining(["shell_client", "shell", "read"]));
    expect(result.toolNameMap.get("shell_client")).toBe("shell");
    const restored = restoreOpencodeToolNames({ output: [{ type: "function_call", name: "shell_client", arguments: "{}" }] }, result.toolNameMap);
    expect(restored.output[0].name).toBe("shell");
  });

  it("keeps a compatible caller `read` on its own name with the OpenCode definition (no alias)", async () => {
    const { result, sent } = await run("opencode", FREE, {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read", description: "mine", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }],
    });
    expect(names(sent.tools).filter((n) => n === "read")).toHaveLength(1);
    expect(names(sent.tools)).not.toContain("read_client");
    expect(result.toolNameMap?.has?.("read_client") ?? false).toBe(false);
  });

  it("merges fingerprint aliases with sanitizer renames in one map", async () => {
    const { result, sent } = await run("opencode", FREE, {
      messages: [{ role: "user", content: "hi" }],
      tools: [callerRead, { type: "function", function: { name: "git:status", parameters: { type: "object", properties: {} } } }],
    });
    expect(names(sent.tools)).toEqual(expect.arrayContaining(["read_client", "git_status"]));
    expect(result.toolNameMap.get("read_client")).toBe("read");
    expect(result.toolNameMap.get("git_status")).toBe("git:status");
  });
});
