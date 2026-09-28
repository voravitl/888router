import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
// Unit-under-test pieces that import open-sse side effects are loaded after mocks.
import { generateAuthData, exchangeTokens } from "../../src/lib/oauth/providers.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import registry from "../../open-sse/providers/registry/zcode.js";
import { PROVIDER_OAUTH } from "../../open-sse/providers/index.js";
import { USAGE_SUPPORTED_PROVIDERS } from "../../src/shared/constants/providers.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("zcode registry", () => {
  it("is a claude-format oauth provider with the plan endpoint", () => {
    expect(registry.category).toBe("oauth");
    expect(registry.features?.usage).toBe(true);
    expect(registry.transports[0].format).toBe("claude");
    expect(registry.transports[0].baseUrl).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
    expect(registry.models.map((m) => m.id)).toContain("glm-5.3-flash");
  });

  it("registers the executor and oauth refresh config", () => {
    expect(getExecutor("zcode").constructor.name).toBe("ZcodeExecutor");
    expect(PROVIDER_OAUTH.zcode?.tokenUrl).toBe("https://zcode.z.ai/api/v1/oauth/token");
    expect(PROVIDER_OAUTH.zcode?.clientId).toBe("client_P8X5CMWmlaRO9gyO-KSqtg");
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("zcode");
  });
});

describe("zcode OAuth flow", () => {
  it("builds a PKCE S256 authorize URL against chat.z.ai with the public appId", async () => {
    const auth = await generateAuthData("zcode", "http://localhost:8080/callback");
    expect(auth.flowType).toBe("authorization_code_pkce");
    expect(auth.authUrl.startsWith("https://chat.z.ai/api/oauth/authorize?")).toBe(true);
    const url = new URL(auth.authUrl);
    expect(url.searchParams.get("client_id")).toBe("client_P8X5CMWmlaRO9gyO-KSqtg");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8080/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(auth.codeVerifier).toBeTruthy();
  });

  it("exchanges the code via form-encoded grant and maps tokens", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, token_type: "bearer" }))
      .mockResolvedValueOnce(jsonResponse({ email: "me@example.com", name: "Tester" }));

    const tokens = await exchangeTokens("zcode", "abc123", "http://localhost:8080/callback", "verifier-43chars-minimum-aaaaaaaaaaaa", "state-1");

    expect(globalThis.fetch).toHaveBeenCalledTimes(2); // token + best-effort userinfo
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://zcode.z.ai/api/v1/oauth/token");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = Object.fromEntries(new URLSearchParams(init.body));
    expect(body).toMatchObject({
      grant_type: "authorization_code",
      code: "abc123",
      client_id: "client_P8X5CMWmlaRO9gyO-KSqtg",
      redirect_uri: "http://localhost:8080/callback",
      code_verifier: "verifier-43chars-minimum-aaaaaaaaaaaa",
    });
    expect(tokens.accessToken).toBe("at-1");
    expect(tokens.refreshToken).toBe("rt-1");
    expect(tokens.expiresIn).toBe(3600);
    expect(tokens.email).toBe("me@example.com");
    expect(tokens.providerSpecificData).toMatchObject({ authMethod: "oauth", plan: "zai-start-plan" });
  });

  it("throws a descriptive error when the exchange is rejected", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400));
    await expect(
      exchangeTokens("zcode", "bad", "http://localhost:8080/callback", "verifier", "state"),
    ).rejects.toThrow(/ZCode token exchange failed/);
  });
});

describe("ZcodeExecutor", () => {
  beforeEach(() => {
    // refreshZcodeToken goes through proxyAwareFetch (module-mocked above),
    // not globalThis.fetch — the exchange tests below still use global fetch.
    proxyAwareFetch.mockResolvedValue(jsonResponse({ access_token: "at-2", refresh_token: "rt-2", expires_in: 1800 }));
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("sends Bearer accessToken through the transport auth descriptor", () => {
    const executor = getExecutor("zcode");
    const headers = executor.buildHeaders({ accessToken: "tok-1" }, false);
    expect(headers.Authorization).toBe("Bearer tok-1");
    // anthropic-version is injected at request time via runtimeTransport.auth
    // (chatCore stamps requestCredentials.runtimeTransport); the bare
    // buildHeaders call has no runtimeTransport, so only the token is asserted.
  });

  it("refreshes via the refresh_token grant and keeps the old token when none is issued", async () => {
    const executor = getExecutor("zcode");
    const refreshed = await executor.refreshCredentials({ refreshToken: "rt-old" }, console);
    expect(refreshed).toMatchObject({ accessToken: "at-2", expiresIn: 1800 });
    const body = Object.fromEntries(new URLSearchParams(proxyAwareFetch.mock.calls[0][1].body));
    expect(body).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt-old", client_id: "client_P8X5CMWmlaRO9gyO-KSqtg" });

    proxyAwareFetch.mockResolvedValue(jsonResponse({ access_token: "at-3" }));
    // NOTE: dedupRefresh caches per (provider, oldToken) for 10s, so the
    // no-rollover leg must use a distinct refresh token to hit the network.
    const noRollover = await executor.refreshCredentials({ refreshToken: "rt-old-2" }, console);
    expect(noRollover.refreshToken).toBe("rt-old-2");

    expect(await executor.refreshCredentials({}, console)).toBeNull();
  });

  it("builds the plan messages URL from the registry transport", () => {
    const executor = getExecutor("zcode");
    expect(executor.buildUrl("glm-5.3-flash", true)).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
  });
});

describe("zcode usage", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns a message when no token is available", async () => {
    const usage = await getUsageForProvider({ provider: "zcode" });
    expect(usage.message).toMatch(/token|re-connect/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("maps percent and limit billing rows into quotas", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      data: {
        plan: { name: "start-plan", percent: 20, resetsAt: "2026-10-28T00:00:00Z" },
        credits: { label: "credits", limit: 1000, used: 250 },
      },
    }));
    const usage = await getUsageForProvider({ provider: "zcode", accessToken: "tok" });
    expect(usage.plan).toBe("ZCode Free");
    expect(usage.quotas["start-plan"]).toMatchObject({ used: 20, total: 100, remaining: 80 });
    expect(usage.quotas["credits"]).toMatchObject({ used: 250, total: 1000 });
  });

  it("surfaces auth failures as a message", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "no" }, 401));
    const usage = await getUsageForProvider({ provider: "zcode", accessToken: "bad" });
    expect(usage.message).toMatch(/auth/i);
  });
});

describe("parseQuotaData(zcode)", () => {
  it("forwards percent rows with remaining and limit rows as used/total", () => {
    const rows = parseQuotaData("zcode", {
      plan: "ZCode Free",
      quotas: {
        "start-plan": { used: 20, total: 100, remaining: 80, resetAt: "2026-10-28T00:00:00Z" },
        credits: { used: 250, total: 1000 },
      },
    });
    expect(rows[0]).toMatchObject({ name: "start-plan", used: 20, total: 100, remaining: 80 });
    expect(rows[1]).toMatchObject({ name: "credits", used: 250, total: 1000 });
    expect(rows[1].remaining).toBeUndefined();
  });
});
