import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(async () => ({})),
  resolveConnectionProxyConfig: vi.fn(async () => ({ connectionProxyEnabled: false })),
  shouldRefreshCredentials: vi.fn(() => false),
  refreshProviderCredentials: vi.fn(async () => null),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("@/lib/network/proxyTest", () => ({
  testProxyUrl: vi.fn(async () => ({ ok: true })),
}));

vi.mock("open-sse/services/oauthCredentialManager.js", () => ({
  shouldRefreshCredentials: mocks.shouldRefreshCredentials,
  refreshProviderCredentials: mocks.refreshProviderCredentials,
}));

import * as shared from "../../open-sse/providers/shared.js";
import kiroConfig from "../../open-sse/providers/registry/kiro.js";
import codexConfig from "../../open-sse/providers/registry/codex.js";
import codexImageProvider from "../../open-sse/handlers/imageProviders/codex.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { getKiroUsage } from "../../open-sse/services/usage/kiro.js";
import { refreshKiroToken } from "../../open-sse/services/tokenRefresh/providers.js";
import { KiroService } from "../../src/lib/oauth/services/kiro.js";
import { testSingleConnection } from "../../src/app/api/providers/[id]/test/testUtils.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

const originalFetch = global.fetch;

describe("shared CLI/IDE version constants and selectAnthropicBeta", () => {
  it("exports bumped CLAUDE_CLI_VERSION, CODEX_CLI_VERSION, KIRO_IDE_VERSION, and KIRO_CLI_VERSION", () => {
    expect(shared.CLAUDE_CLI_VERSION).toBe("2.1.328");
    expect(shared.CODEX_CLI_VERSION).toBe("0.164.0");
    expect(shared.KIRO_IDE_VERSION).toBe("1.4.154");
    expect(shared.KIRO_CLI_VERSION).toBe("3.5.0");
  });

  it.each([
    "claude-haiku-5-5",
    "claude-haiku-5.5",
    "claude-opus-4.7",
    "claude-opus-4-7",
    "claude-fable-5-2",
  ])("selectAnthropicBeta returns full adaptive/effort/structured-outputs flags for %s", (model) => {
    const beta = shared.selectAnthropicBeta(model);
    expect(beta).toContain("advanced-tool-use-2025-11-20");
    expect(beta).toContain("effort-2025-11-24");
    expect(beta).toContain("structured-outputs-2025-12-15");
    expect(beta).toContain("fast-mode-2026-02-01");
    expect(beta).toContain("redact-thinking-2026-02-12");
    expect(beta).toContain("token-efficient-tools-2026-03-28");
  });

  it.each([
    "claude-haiku-4.5",
    "claude-sonnet-4.6",
  ])("selectAnthropicBeta keeps base flags only for %s", (model) => {
    const beta = shared.selectAnthropicBeta(model);
    expect(beta).toContain("claude-code-20250219");
    expect(beta).not.toContain("effort-2025-11-24");
  });

  it("DefaultExecutor.buildHeaders merges selectAnthropicBeta for anthropic-compatible haiku-5-5 and opus-4.7", () => {
    const exec = new DefaultExecutor("anthropic-compatible-test");
    const hHaiku = exec.buildHeaders({ apiKey: "sk-test", providerSpecificData: { baseUrl: "https://api.anthropic.com/v1" } }, true, "", "claude-haiku-5-5");
    expect(hHaiku["Anthropic-Beta"]).toContain("effort-2025-11-24");
    const hOpus47 = exec.buildHeaders({ apiKey: "sk-test", providerSpecificData: { baseUrl: "https://api.anthropic.com/v1" } }, true, "", "claude-opus-4.7");
    expect(hOpus47["Anthropic-Beta"]).toContain("structured-outputs-2025-12-15");
  });
});

describe("Kiro UA unification and live static models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sets KIRO_IDE_VERSION on kiro registry transport headers", () => {
    expect(kiroConfig.transport.headers["User-Agent"]).toBe("AWS-SDK-JS/3.0.0 kiro-ide/1.4.154");
    expect(kiroConfig.transport.headers["X-Amz-User-Agent"]).toBe("aws-sdk-js/3.0.0 kiro-ide/1.4.154");
  });

  it("includes active live Kiro models while preserving existing synthetic variants", () => {
    const ids = kiroConfig.models.map((m) => m.id);
    const expectedActive = [
      "auto",
      "claude-opus-5.5",
      "claude-sonnet-5.5",
      "claude-haiku-5.5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "grok-4.7",
      "kimi-k3",
      "claude-opus-4.6",
      "claude-sonnet-4.6",
      "minimax-m2.5",
      "minimax-m2.1",
    ];
    for (const id of expectedActive) {
      expect(ids, `missing ${id}`).toContain(id);
    }
    expect(ids).toEqual(expect.arrayContaining([
      "claude-opus-5",
      "claude-opus-5-thinking",
      "claude-opus-5-agentic",
      "claude-opus-5-thinking-agentic",
      "claude-sonnet-5",
      "claude-sonnet-5-thinking",
      "claude-sonnet-5-agentic",
      "claude-sonnet-5-thinking-agentic",
      "MiniMax-M2.5",
    ]));
  });

  it("sends KIRO_IDE_VERSION in KiroService (OAuth) CodeWhisperer headers", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [] }), { status: 200 })
    );
    const svc = new KiroService();
    await svc.listAvailableModels("tok", "");
    const [, init] = global.fetch.mock.calls[0];
    expect(init.headers["User-Agent"]).toBe("AWS-SDK-JS/3.0.0 kiro-ide/1.4.154");
    expect(init.headers["X-Amz-User-Agent"]).toBe("aws-sdk-js/3.0.0 kiro-ide/1.4.154");
  });

  it("sends KIRO_IDE_VERSION in getKiroUsage headers", async () => {
    mocks.proxyAwareFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ subscriptionInfo: { subscriptionTitle: "Kiro" }, usageBreakdownList: [] }), { status: 200 })
    );
    await getKiroUsage("tok", {});
    const [, init] = mocks.proxyAwareFetch.mock.calls[0];
    expect(init.headers["user-agent"]).toContain("1.4.154");
    expect(init.headers["x-amz-user-agent"]).toContain("1.4.154");
  });

  it("sends kiro-cli/3.5.0 on DefaultExecutor.refreshKiro, tokenRefresh/providers.refreshKiroToken, and testUtils", async () => {
    mocks.proxyAwareFetch.mockImplementation(async () =>
      new Response(JSON.stringify({ accessToken: "new-tok", refreshToken: "new-ref", expiresIn: 3600 }), { status: 200 })
    );

    const exec = new DefaultExecutor("kiro");
    await exec.refreshKiro("ref-tok");
    expect(mocks.proxyAwareFetch.mock.calls[0][1].headers["User-Agent"]).toBe("kiro-cli/3.5.0");

    await refreshKiroToken("ref-tok", { profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/TEST" });
    expect(mocks.proxyAwareFetch.mock.calls[1][1].headers["User-Agent"]).toBe("kiro-cli/3.5.0");

    global.fetch.mockClear();

    mocks.shouldRefreshCredentials.mockReturnValue(true);
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "kiro-social-1",
      provider: "kiro",
      authType: "oauth",
      accessToken: "old-tok",
      refreshToken: "ref-tok",
      providerSpecificData: {},
    });
    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: "new-tok", refreshToken: "new-ref", expiresIn: 3600 }), { status: 200 })
    );
    const result = await testSingleConnection("kiro-social-1");
    expect(result.valid).toBe(true);
    expect(global.fetch.mock.calls[0][1].headers["User-Agent"]).toBe("kiro-cli/3.5.0");
  });
});

describe("Codex UA unification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("uses CODEX_CLI_VERSION in registry/codex.js, imageProviders/codex.js, and testUtils.js", async () => {
    expect(codexConfig.transport.headers["User-Agent"]).toBe("codex_cli_rs/0.164.0");

    const imgHeaders = codexImageProvider.buildHeaders({ accessToken: "tok" });
    expect(imgHeaders["user-agent"]).toBe("codex_cli_rs/0.164.0");
    expect(imgHeaders["version"]).toBe("0.164.0");

    mocks.shouldRefreshCredentials.mockReturnValue(false);
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "codex-1",
      provider: "codex",
      authType: "oauth",
      accessToken: "tok",
    });
    global.fetch.mockResolvedValueOnce(new Response("{}", { status: 400 }));
    const result = await testSingleConnection("codex-1");
    expect(result.valid).toBe(true);
    expect(global.fetch.mock.calls[0][1].headers["User-Agent"]).toBe("codex_cli_rs/0.164.0");
  });
});

describe("Capabilities and thinkingLevels updates", () => {
  it("sets thinkingCanDisable: false and omitThinkingSwitch: true on Fable entries and pattern", () => {
    for (const model of ["claude-fable-5", "claude-fable-5-1", "claude-fable-5.1", "claude-fable-5-2", "claude-fable-5.2", "anthropic/claude-fable-5.2-high"]) {
      const caps = getCapabilitiesForModel("claude", model);
      expect(caps.thinkingCanDisable, model).toBe(false);
      expect(caps.omitThinkingSwitch, model).toBe(true);
      expect(getThinkingLevels("claude", model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
  });

  it("sets thinkingCanDisable: false on Opus 5.5 models without omitting adaptive switch", () => {
    for (const model of ["claude-opus-5-5", "claude-opus-5-5-high", "claude-opus-5-5-medium", "claude-opus-5-5-low", "claude-opus-5.5"]) {
      const caps = getCapabilitiesForModel("claude", model);
      expect(caps.thinkingCanDisable, model).toBe(false);
      expect(caps.omitThinkingSwitch, model).not.toBe(true);
      expect(getThinkingLevels("claude", model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
  });

  it("sets thinkingDisableType: between_tools on Sonnet 5.5 while keeping thinkingCanDisable: true", () => {
    for (const model of ["claude-sonnet-5-5", "claude-sonnet-5-5-high", "claude-sonnet-5-5-medium", "claude-sonnet-5-5-low", "claude-sonnet-5.5"]) {
      const caps = getCapabilitiesForModel("claude", model);
      expect(caps.thinkingCanDisable, model).toBe(true);
      expect(caps.thinkingDisableType, model).toBe("between_tools");
      expect(getThinkingLevels("claude", model)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    }
  });

  it("adds claude-haiku-5-5 capability and Claude 4.7+/4.8/5/5.5/Fable/Mythos xhigh levels while keeping 4.6 without xhigh", () => {
    expect(getCapabilitiesForModel("claude", "claude-haiku-5-5")).toMatchObject({
      vision: true,
      reasoning: true,
      search: true,
      thinkingFormat: "claude-adaptive",
      contextWindow: 1000000,
      maxOutput: 128000,
    });
    for (const model of ["claude-opus-4.7", "claude-opus-4-7", "claude-opus-4.8", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-5", "claude-haiku-5-5", "claude-mythos-1"]) {
      expect(getThinkingLevels("claude", model), model).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    }
    for (const model of ["claude-opus-4.6", "claude-opus-4-6", "claude-sonnet-4.6", "claude-sonnet-4-6"]) {
      expect(getThinkingLevels("claude", model), model).toEqual(["none", "low", "medium", "high", "max"]);
    }
  });

  it("gives Gemini 4 Hydrogen & Neon pdf:true + 262144 maxOutput + xhigh while keeping Argon at 65536", () => {
    for (const provider of ["antigravity", "gemini", "vertex"]) {
      for (const model of ["gemini-4-hydrogen", "gemini-4-neon", "gemini-4-neon-high"]) {
        const caps = getCapabilitiesForModel(provider, model);
        expect(caps.pdf, `${provider}/${model}`).toBe(true);
        expect(caps.maxOutput, `${provider}/${model}`).toBe(262144);
        expect(caps.thinkingCanDisable, `${provider}/${model}`).toBe(false);
        expect(getThinkingLevels(provider, model), `${provider}/${model}`).toEqual(["low", "medium", "high", "xhigh"]);
      }
      const argon = getCapabilitiesForModel(provider, "gemini-4-argon-high");
      expect(argon.maxOutput).toBe(65536);
      expect(getThinkingLevels(provider, "gemini-4-argon-high")).toEqual(["low", "medium", "high"]);
    }
  });

  it("registers the 5 new opencode live model capabilities", () => {
    expect(getCapabilitiesForModel("oc", "longcat-2.5-free")).toMatchObject({ reasoning: true, vision: true, contextWindow: 1000000, maxOutput: 262144 });
    expect(getCapabilitiesForModel("oc", "iceman-free")).toMatchObject({ reasoning: true, contextWindow: 262144, maxOutput: 131072 });
    expect(getCapabilitiesForModel("oc", "inkling-2-small-free")).toMatchObject({ reasoning: true, vision: true, contextWindow: 1048576, maxOutput: 131072 });
    expect(getCapabilitiesForModel("oc", "hy4-flash-free")).toMatchObject({ reasoning: true, vision: true, contextWindow: 1048576, maxOutput: 65536 });
    expect(getCapabilitiesForModel("oc", "tidepool-alpha-free")).toMatchObject({ reasoning: true, contextWindow: 1048576, maxOutput: 131072 });
  });
});
