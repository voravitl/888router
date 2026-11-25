import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const connectionWrites = [];
const mockConnections = new Map();

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ providerStrategies: {} })),
  getProviderConnections: vi.fn(async ({ provider } = {}) =>
    [...mockConnections.values()].filter((c) => !provider || c.provider === provider)
  ),
  getProviderConnectionById: vi.fn(async (id) => mockConnections.get(id) || null),
  updateProviderConnection: vi.fn(async (id, data) => {
    connectionWrites.push({ id, ...data });
    const existing = mockConnections.get(id) || { id };
    const updated = { ...existing, ...data };
    for (const [k, v] of Object.entries(data)) {
      if (v === null) delete updated[k];
    }
    mockConnections.set(id, updated);
    return updated;
  }),
  validateApiKey: vi.fn(async () => ({ valid: false })),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    vercelRelayUrl: "",
  })),
}));

vi.mock("@/lib/network/proxyFetch", () => ({
  fetchWithConnectionProxy: (...args) => globalThis.fetch(...args),
}));

vi.mock("@/lib/network/proxyTest", () => ({
  testProxyUrl: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/db/repos/proxyPoolsRepo", () => ({
  getProxyPools: vi.fn(async () => []),
  getProxyPoolById: vi.fn(async () => null),
  updateProxyPool: vi.fn(async () => null),
}));

vi.mock("open-sse/services/quotaSnapshot.js", () => ({
  partitionByQuotaHealth: vi.fn((conns) => ({ healthy: conns })),
  QUOTA_AVOID_THRESHOLD_PCT: 0.9,
  QUOTA_SNAPSHOT_MAX_AGE_MS: 60_000,
}));

vi.mock("open-sse/services/accountScoring.js", () => ({
  pickByScore: vi.fn((pool) => ({ connection: pool[0], breakdown: { reason: "mock" } })),
}));

vi.mock("../../src/sse/utils/logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

const require = createRequire(import.meta.url);

function mockResponse(status, body = null, headers = {}) {
  return {
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    clone: () => ({ text: async () => (body == null ? "" : JSON.stringify(body)) }),
  };
}

describe("Antigravity Anti-Ban Hardening", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    connectionWrites.length = 0;
    mockConnections.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("1. No x-request-source: local leak to Google upstream", () => {
    it("AntigravityExecutor.buildHeaders omits x-request-source when host is not MITM-redirected", async () => {
      const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
      const { shouldSendMitmLoopHeader } = await import("../../open-sse/utils/mitmLoopHeader.js");
      const executor = new AntigravityExecutor();
      const headers = executor.buildHeaders(
        { accessToken: "tok" },
        true,
        "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
      );

      expect(headers["x-request-source"]).toBeUndefined();
      expect(headers["X-Request-Source"]).toBeUndefined();
      expect(shouldSendMitmLoopHeader("https://daily-cloudcode-pa.googleapis.com", "")).toBe(false);
      expect(shouldSendMitmLoopHeader("https://daily-cloudcode-pa.googleapis.com", "127.0.0.1 daily-cloudcode-pa.googleapis.com")).toBe(true);
    });

    it("sanitizeAntigravityPrompt strips short standalone Claude Code / agent self-ID prefixes safely", async () => {
      const { sanitizeAntigravityPrompt } = await import("../../open-sse/executors/antigravity.js");
      expect(sanitizeAntigravityPrompt("You are Claude Code. Solve the user task.")).toBe("Solve the user task.");
      expect(sanitizeAntigravityPrompt("You are a Claude agent. Help fix this bug.")).toBe("Help fix this bug.");
      expect(sanitizeAntigravityPrompt("Do not break discussions about Claude Code internals.")).toBe("Do not break discussions about Claude Code internals.");
    });

    it("parseHostsRedirectMatch detects active loopback redirects and ignores comments", async () => {
      const { parseHostsRedirectMatch } = await import("../../open-sse/utils/mitmLoopHeader.js");
      const hostsText = [
        "# 127.0.0.1 daily-cloudcode-pa.googleapis.com",
        "127.0.0.1 localhost",
        "127.0.0.1 daily-cloudcode-pa.googleapis.com cloudcode-pa.googleapis.com # added by 9router",
      ].join("\n");

      expect(parseHostsRedirectMatch(hostsText, "daily-cloudcode-pa.googleapis.com")).toBe(true);
      expect(parseHostsRedirectMatch(hostsText, "cloudcode-pa.googleapis.com")).toBe(true);
      expect(parseHostsRedirectMatch(hostsText, "www.googleapis.com")).toBe(false);
      expect(parseHostsRedirectMatch("# 127.0.0.1 daily-cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com")).toBe(false);
    });

    it("MITM passthrough sanitizer strips x-request-source case-insensitively before upstream forwarding", () => {
      const { stripInternalLoopHeaders } = require("../../src/mitm/passthroughHeaders.js");
      const sanitized = stripInternalLoopHeaders({
        authorization: "Bearer secret",
        "user-agent": "antigravity/hub/2.35.0 darwin/arm64",
        "x-request-source": "local",
        "X-Request-Source": "local",
        host: "daily-cloudcode-pa.googleapis.com",
      });

      expect(sanitized["x-request-source"]).toBeUndefined();
      expect(sanitized["X-Request-Source"]).toBeUndefined();
      expect(sanitized.authorization).toBe("Bearer secret");
      expect(sanitized["user-agent"]).toBe("antigravity/hub/2.35.0 darwin/arm64");
    });

    it("OAuth postExchange never hardcodes x-request-source on www.googleapis.com userInfo", () => {
      const oauthProvidersSrc = fs.readFileSync(
        path.resolve("src/lib/oauth/providers.js"),
        "utf8"
      );
      const userInfoIdx = oauthProvidersSrc.indexOf("ANTIGRAVITY_CONFIG.userInfoUrl");
      const loadCodeIdx = oauthProvidersSrc.indexOf("ANTIGRAVITY_CONFIG.loadCodeAssistEndpoint");
      expect(userInfoIdx).toBeGreaterThan(-1);
      const userInfoSnippet = oauthProvidersSrc.slice(userInfoIdx, loadCodeIdx);
      expect(userInfoSnippet).not.toContain('"x-request-source": "local"');
    });
  });

  describe("2. No 429 sandbox double-burst & veto restriction retries in AntigravityExecutor", () => {
    it("shouldRetry disables redundant 429 failover onto sandbox.googleapis.com", async () => {
      const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
      const executor = new AntigravityExecutor();
      expect(executor.shouldRetry(429, 0)).toBe(false);
    });

    it("computeRetryDelay vetoes retry immediately on 403 or VALIDATION_REQUIRED / suspended 429", async () => {
      const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
      const executor = new AntigravityExecutor();

      expect(await executor.computeRetryDelay(mockResponse(403, { error: { message: "PERMISSION_DENIED" } }), 1)).toBe(false);
      expect(
        await executor.computeRetryDelay(
          mockResponse(429, { error: { message: "VALIDATION_REQUIRED: Verify your account to continue." } }),
          1
        )
      ).toBe(false);
      expect(
        await executor.computeRetryDelay(
          mockResponse(429, { error: { message: "Your account has been suspended for abuse." } }),
          1
        )
      ).toBe(false);
    });
  });

  describe("3. Long quarantine for Antigravity 403, VALIDATION_REQUIRED & account suspension", () => {
    it("classifies VALIDATION_REQUIRED and account suspension as long provider-level quarantine while keeping relay 'is suspended' pool-scoped", async () => {
      const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");
      const { ACCOUNT_VALIDATION_PARK_MS, POOL_SUSPEND_PARK_MS } = await import("../../open-sse/config/errorConfig.js");

      const validation = checkFallbackError(403, "PERMISSION_DENIED: VALIDATION_REQUIRED - verify your account");
      expect(validation.shouldFallback).toBe(true);
      expect(validation.parkMs).toBeGreaterThanOrEqual(ACCOUNT_VALIDATION_PARK_MS);
      expect(validation.parkScope).toBe("provider");

      const acctDisabled = checkFallbackError(403, "Your account has been disabled for Terms of Service violation.");
      expect(acctDisabled.parkMs).toBeGreaterThanOrEqual(ACCOUNT_VALIDATION_PARK_MS);
      expect(acctDisabled.parkScope).toBe("provider");

      // Preserve existing Deno/Vercel relay suspend behavior (must stay pool-scoped!)
      const relaySuspend = checkFallbackError(503, "(USAGE_EXCEEDED) This application is suspended due to usage limits being exceeded.");
      expect(relaySuspend.parkMs).toBe(POOL_SUSPEND_PARK_MS);
      expect(relaySuspend.parkScope).toBe("pool");
    });

    it("markAccountUnavailable locks Antigravity for >= 1h on 403 and 6h on VALIDATION_REQUIRED instead of 2m", async () => {
      const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");
      const { ACCOUNT_VALIDATION_PARK_MS, ANTIGRAVITY_PERMISSION_COOLDOWN_MS } = await import("../../open-sse/config/errorConfig.js");

      mockConnections.set("ag-1", { id: "ag-1", provider: "antigravity", isActive: true, backoffLevel: 0 });
      const before = Date.now();
      await markAccountUnavailable("ag-1", 403, "PERMISSION_DENIED", "antigravity", "gemini-4-hydrogen");

      const after403 = mockConnections.get("ag-1");
      expect(after403.testStatus).toBe("unavailable");
      expect(new Date(after403.modelLock___all).getTime()).toBeGreaterThanOrEqual(before + ANTIGRAVITY_PERMISSION_COOLDOWN_MS - 1000);

      mockConnections.set("ag-2", { id: "ag-2", provider: "antigravity", isActive: true, backoffLevel: 0 });
      const beforeVal = Date.now();
      await markAccountUnavailable("ag-2", 403, "VALIDATION_REQUIRED: Verify your account", "antigravity", "gemini-4-hydrogen");

      const afterVal = mockConnections.get("ag-2");
      expect(new Date(afterVal.modelLock___all).getTime()).toBeGreaterThanOrEqual(beforeVal + ACCOUNT_VALIDATION_PARK_MS - 1000);
    });

    it("markAccountUnavailable respects rule parkMs on saved connections when body says 'is suspended' (not 5s COOLDOWN.short)", async () => {
      const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");
      const { POOL_SUSPEND_PARK_MS } = await import("../../open-sse/config/errorConfig.js");

      mockConnections.set("conn-susp", { id: "conn-susp", provider: "claude", isActive: true, backoffLevel: 0 });
      const before = Date.now();
      await markAccountUnavailable("conn-susp", 503, "This application is suspended", "claude", "claude-sonnet-4");

      const updated = mockConnections.get("conn-susp");
      expect(new Date(updated["modelLock_claude-sonnet-4"]).getTime()).toBeGreaterThanOrEqual(before + POOL_SUSPEND_PARK_MS - 1000);
    });

    it("combo.js fails over and locks ag/* provider-wide on Antigravity 403 restriction", async () => {
      const {
        handleComboChat,
        isAccountRestrictedFailure,
        getComboKnownUnavailable,
        clearComboKnownUnavailable,
      } = await import("../../open-sse/services/combo.js");

      clearComboKnownUnavailable();
      expect(isAccountRestrictedFailure(403, "PERMISSION_DENIED", "antigravity")).toBe(true);
      expect(isAccountRestrictedFailure(403, "VALIDATION_REQUIRED", "openai")).toBe(true);
      expect(isAccountRestrictedFailure(403, "forbidden", "openrouter")).toBe(false);

      const seen = [];
      const okRes = () =>
        new Response(
          JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      const restrictedRes = () =>
        new Response(
          JSON.stringify({ error: { message: "PERMISSION_DENIED: VALIDATION_REQUIRED" } }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );

      const handleSingleModel = async (_b, modelStr) => {
        seen.push(modelStr);
        return modelStr.startsWith("ag/") ? restrictedRes() : okRes();
      };

      const models = ["ag/gemini-4-hydrogen", "ag/claude-sonnet-5-5-high", "cc/claude-sonnet-5-5"];
      const res = await handleComboChat({
        body: { messages: [{ role: "user", content: "hi" }] },
        models,
        handleSingleModel,
        log: { info: vi.fn(), warn: vi.fn() },
        comboName: "ag-safety-test",
        comboStrategy: "fallback",
      });

      expect(res.ok).toBe(true);
      expect(seen).toEqual(["ag/gemini-4-hydrogen", "cc/claude-sonnet-5-5"]);
      expect(getComboKnownUnavailable("ag/gemini-4-hydrogen")).toBeGreaterThan(Date.now() + 30 * 60 * 1000);
      expect(getComboKnownUnavailable("ag/claude-sonnet-5-5-high")).toBeGreaterThan(Date.now() + 30 * 60 * 1000);

      clearComboKnownUnavailable();
    });

    it("testSingleConnection clears stale modelLock_* and resets backoffLevel when Antigravity passes re-test", async () => {
      mockConnections.set("ag-recover", {
        id: "ag-recover",
        provider: "antigravity",
        authType: "oauth",
        accessToken: "valid-token",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        testStatus: "unavailable",
        backoffLevel: 4,
        modelLock___all: new Date(Date.now() + 6 * 3600_000).toISOString(),
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: "proj-1" }),
      });

      const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
      const res = await testSingleConnection("ag-recover");

      expect(res.valid).toBe(true);
      const updated = mockConnections.get("ag-recover");
      expect(updated.testStatus).toBe("active");
      expect(updated.backoffLevel).toBe(0);
      expect(updated.modelLock___all).toBeUndefined();
    });
  });
});
