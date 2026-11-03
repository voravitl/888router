import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));
vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
  createSSETransformStreamWithLogger: vi.fn(() => new TransformStream()),
  createClaudeNativeStreamWithLogger: vi.fn(() => new TransformStream()),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

// A Claude Code request carries sourceFormat=claude, so chatCore sets
// preserveRequestInput=true and every saver used to be skipped. RTK is now
// gated separately; this pins that boundary so a future refactor cannot
// silently re-disable it or let the lossy savers back in.
//
// The payload has repeated lines because dedup-log (the only filter that fires
// on undifferentiated text) only saves when content repeats. Distinct source
// lines legitimately come back unchanged under RTK_LOSSY=off.
const TOOL_BODY = "  1|const a = 1;\n  1|const a = 1;\n  1|const a = 1;\n  2|const b = 2;\n";


function claudeBody() {
  return {
    model: "claude-sonnet-4-5", max_tokens: 64, messages: [
      { role: "user", content: "read the file" },
      { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: TOOL_BODY.repeat(40) }] }] },
    ],
  };
}

async function run(headers = {}, body = claudeBody()) {
  executeMock.mockResolvedValue({
    response: new Response(JSON.stringify({
      id: "c1", object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
    url: "https://api.anthropic.com/v1/messages",
    headers: {},
    transformedBody: null,
  });
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
  await handleChatCore({
    body,
    modelInfo: { provider: "anthropic", model: "claude-sonnet-4-5" },
    credentials: { apiKey: "k", providerSpecificData: {} },
    log,
    connectionId: "c",
    rtkEnabled: true,
    prunerEnabled: true,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    clientRawRequest: { endpoint: "/v1/messages", body, headers: { "user-agent": "claude-cli/2.0.0", ...headers } },
    // Pin the source format: the test body is Claude-shaped, but detection of
    // the client and the format are separate inputs, and the gate under test
    // keys on both.
    sourceFormatOverride: "claude",
  });
  return { log, executed: executeMock.mock.calls.at(-1)?.[0] };
}

describe("RTK on preserved (Claude Code) input", () => {
  const saved = {};
  let logs;
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of ["RTK_ON_PRESERVED_INPUT", "RTK_LOSSY"]) { saved[k] = process.env[k]; delete process.env[k]; }
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args.map(String).join(" ")); });
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
  });
  const allLogText = () => logs.join("\n");

  it("stays off by default, so preserved input is untouched", async () => {
    await run();
    expect(allLogText()).not.toContain("[RTK]");
  });

  it("runs with RTK_ON_PRESERVED_INPUT=on", async () => {
    process.env.RTK_ON_PRESERVED_INPUT = "on";
    await run();
    expect(allLogText()).toContain("[RTK]");
  });

  it("RTK_LOSSY=off leaves the tool_result text byte-identical", async () => {
    process.env.RTK_ON_PRESERVED_INPUT = "on";
    process.env.RTK_LOSSY = "off";
    const { executed } = await run();
    const json = JSON.stringify(executed?.body ?? executed ?? {});
    // dedup-log/read-numbered/smart-truncate are skipped, so the original bytes
    // survive and RTK reports no hit at all.
    expect(json).toContain("  1|const a = 1;");
    expect(json).not.toContain("truncated");
    expect(allLogText()).not.toContain("[RTK]");
  });

  it("RTK_LOSSY=off still applies a format-only filter", async () => {
    process.env.RTK_ON_PRESERVED_INPUT = "on";
    process.env.RTK_LOSSY = "off";
    const status = " M src/a.js\n M src/b.js\n M src/c.js\n?? n1.js\n?? n2.js\n";
    const statusBody = {
      model: "claude-sonnet-4-5", max_tokens: 64, messages: [
        { role: "user", content: "check status" },
        { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: status.repeat(20) }] }] },
      ],
    };
    const { executed } = await run({}, statusBody);
    const json = JSON.stringify(executed?.body ?? executed ?? {});
    // git-status collapses the listing but keeps every file name.
    expect(json).toContain("src/a.js");
    expect(allLogText()).toContain("git-status");
  });
});
