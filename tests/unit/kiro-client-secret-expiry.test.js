import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => []),
  getProviderConnectionById: vi.fn(async () => null),
  updateProviderConnection: vi.fn(async () => ({})),
  createProviderConnection: vi.fn(async (data) => ({ id: "conn-imported-1", ...data })),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));

function makeJwt(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

describe("Kiro clientSecretExpiresAt persistence and safe client projection", () => {
  let tempDirs = [];
  let fetchMock;
  const originalCacheDir = process.env.AWS_SSO_CACHE_DIR;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    mocks.getProviderConnections.mockReset();
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.getProviderConnectionById.mockReset();
    mocks.getProviderConnectionById.mockResolvedValue(null);
    mocks.updateProviderConnection.mockReset();
    mocks.updateProviderConnection.mockResolvedValue({});
    mocks.createProviderConnection.mockReset();
    mocks.createProviderConnection.mockImplementation(async (data) => ({ id: "conn-imported-1", ...data }));
    delete process.env.AWS_SSO_CACHE_DIR;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.doUnmock("open-sse/services/usage.js");
    vi.doUnmock("open-sse/executors/index.js");
    vi.doUnmock("@/lib/network/connectionProxy");
    vi.doUnmock("@/models");
    vi.doUnmock("@/lib/oauth/services/kiro");
    if (originalCacheDir === undefined) {
      delete process.env.AWS_SSO_CACHE_DIR;
    } else {
      process.env.AWS_SSO_CACHE_DIR = originalCacheDir;
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("captures and normalizes epoch-second clientSecretExpiresAt across requestDeviceCode -> pollForToken -> mapTokens", async () => {
    const expiresAtEpochSec = 1794560400; // 2026-11-12T09:00:00.000Z
    const expectedIso = new Date(expiresAtEpochSec * 1000).toISOString();
    const accessToken = makeJwt({ email: "user@bank.example" });

    fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          clientId: "cid-123",
          clientSecret: "csec-456",
          clientSecretExpiresAt: expiresAtEpochSec,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          deviceCode: "dev-1",
          userCode: "USER-1",
          verificationUri: "https://device.sso.ap-southeast-1.amazonaws.com/",
          verificationUriComplete: "https://device.sso.ap-southeast-1.amazonaws.com/?user_code=USER-1",
          expiresIn: 600,
          interval: 5,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          accessToken,
          refreshToken: "rt-1",
          expiresIn: 3600,
          profileArn: "arn:aws:codewhisperer:ap-southeast-1:123456789012:profile/ABC",
        }),
      });

    const { getProvider, pollForToken } = await import("../../src/lib/oauth/providers.js");
    const kiroProvider = getProvider("kiro");

    const deviceInfo = await kiroProvider.requestDeviceCode(kiroProvider.config, null, {
      authMethod: "idc",
      region: "ap-southeast-1",
      startUrl: "https://corp.awsapps.com/start",
    });

    expect(deviceInfo._clientSecretExpiresAt).toBe(expiresAtEpochSec);

    const pollRes = await pollForToken("kiro", "dev-1", null, deviceInfo);
    expect(pollRes.success).toBe(true);
    expect(pollRes.tokens.providerSpecificData).toMatchObject({
      clientId: "cid-123",
      clientSecret: "csec-456",
      region: "ap-southeast-1",
      authMethod: "idc",
      startUrl: "https://corp.awsapps.com/start",
      clientSecretExpiresAt: expectedIso,
    });
  });

  it("handles missing or invalid clientSecretExpiresAt gracefully as null", async () => {
    const { getProvider } = await import("../../src/lib/oauth/providers.js");
    const kiroProvider = getProvider("kiro");

    const mappedMissing = kiroProvider.mapTokens({
      access_token: "opaque-token",
      refresh_token: "rt-1",
      expires_in: 3600,
      _clientId: "cid",
      _clientSecret: "csec",
    });
    expect(mappedMissing.providerSpecificData.clientSecretExpiresAt).toBeNull();

    const mappedIso = kiroProvider.mapTokens({
      access_token: "opaque-token",
      refresh_token: "rt-1",
      expires_in: 3600,
      _clientId: "cid",
      _clientSecret: "csec",
      _clientSecretExpiresAt: "2027-02-01T00:00:00.000Z",
    });
    expect(mappedIso.providerSpecificData.clientSecretExpiresAt).toBe("2027-02-01T00:00:00.000Z");
  });

  it("exposes clientSecretExpiresAt in GET /api/providers/client without leaking clientSecret or tokens", async () => {
    const expiryIso = "2026-11-12T04:15:47.000Z";
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-kiro-1",
        provider: "kiro",
        authType: "oauth",
        name: "Account 2",
        isActive: true,
        testStatus: "unavailable",
        accessToken: "secret-access",
        refreshToken: "secret-refresh",
        providerSpecificData: {
          authMethod: "idc",
          region: "ap-southeast-1",
          profileArn: "arn:aws:codewhisperer:ap-southeast-1:111:profile/XYZ",
          clientId: "secret-client-id",
          clientSecret: "secret-client-secret",
          clientSecretExpiresAt: expiryIso,
        },
      },
    ]);

    const { GET } = await import("../../src/app/api/providers/client/route.js");
    const response = await GET(new Request("http://localhost/api/providers/client?provider=kiro"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.connections).toHaveLength(1);
    const conn = body.connections[0];
    expect(conn.providerSpecificData.clientSecretExpiresAt).toBe(expiryIso);
    expect(conn.providerSpecificData.clientSecret).toBeUndefined();
    expect(conn.providerSpecificData.clientId).toBeUndefined();
    expect(conn.accessToken).toBeUndefined();
    expect(conn.refreshToken).toBeUndefined();
  });

  it("heals stale IDC registration from AWS_SSO_CACHE_DIR when primary OIDC refresh returns 400", async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "kiro-sso-cache-"));
    tempDirs.push(cacheDir);
    process.env.AWS_SSO_CACHE_DIR = cacheDir;

    const futureIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await fs.writeFile(
      path.join(cacheDir, "kiro-auth-token.json"),
      JSON.stringify({
        refreshToken: "aorAAACachedRefreshSecret",
        authMethod: "IdC",
        region: "ap-southeast-1",
        clientIdHash: "client-hash-abc123",
      }),
      "utf-8"
    );
    await fs.writeFile(
      path.join(cacheDir, "client-hash-abc123.json"),
      JSON.stringify({
        clientId: "cached-client-id",
        clientSecret: "cached-client-secret-value",
        expiresAt: futureIso,
      }),
      "utf-8"
    );

    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: "invalid_request" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          accessToken: "healed-access-token",
          refreshToken: "rotated-refresh-token",
          expiresIn: 3600,
          profileArn: "arn:aws:codewhisperer:ap-southeast-1:123456789012:profile/HEALED",
        }),
      });

    const logCalls = [];
    const mockLog = {
      info: (...args) => logCalls.push(JSON.stringify(args)),
      warn: (...args) => logCalls.push(JSON.stringify(args)),
      error: (...args) => logCalls.push(JSON.stringify(args)),
    };

    const { refreshKiroToken } = await import("../../open-sse/services/tokenRefresh/providers.js");
    const result = await refreshKiroToken(
      "stale-refresh-token",
      {
        authMethod: "idc",
        clientId: "stale-client-id",
        clientSecret: "stale-client-secret",
        region: "ap-southeast-1",
        startUrl: "https://corp.awsapps.com/start",
      },
      mockLog
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://oidc.ap-southeast-1.amazonaws.com/token");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      clientId: "stale-client-id",
      clientSecret: "stale-client-secret",
      refreshToken: "stale-refresh-token",
      grantType: "refresh_token",
    });

    expect(fetchMock.mock.calls[1][0]).toBe("https://oidc.ap-southeast-1.amazonaws.com/token");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      clientId: "cached-client-id",
      clientSecret: "cached-client-secret-value",
      refreshToken: "aorAAACachedRefreshSecret",
      grantType: "refresh_token",
    });

    expect(result).toEqual({
      accessToken: "healed-access-token",
      refreshToken: "rotated-refresh-token",
      expiresIn: 3600,
      providerSpecificData: {
        authMethod: "idc",
        clientId: "cached-client-id",
        clientSecret: "cached-client-secret-value",
        clientSecretExpiresAt: futureIso,
        region: "ap-southeast-1",
        startUrl: "https://corp.awsapps.com/start",
        profileArn: "arn:aws:codewhisperer:ap-southeast-1:123456789012:profile/HEALED",
      },
    });

    const combinedLogs = logCalls.join("\n");
    for (const secret of [
      "stale-client-secret",
      "cached-client-secret-value",
      "stale-refresh-token",
      "aorAAACachedRefreshSecret",
      "rotated-refresh-token",
      "healed-access-token",
    ]) {
      expect(combinedLogs).not.toContain(secret);
    }
  });

  it("skips AWS SSO cache fallback when cached client registration is already expired or identical", async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "kiro-sso-cache-expired-"));
    tempDirs.push(cacheDir);
    process.env.AWS_SSO_CACHE_DIR = cacheDir;

    await fs.writeFile(
      path.join(cacheDir, "kiro-auth-token.json"),
      JSON.stringify({
        refreshToken: "aorAAACachedNewToken",
        authMethod: "idc",
        region: "us-east-1",
        clientIdHash: "expired-hash",
      }),
      "utf-8"
    );
    await fs.writeFile(
      path.join(cacheDir, "expired-hash.json"),
      JSON.stringify({
        clientId: "expired-cid",
        clientSecret: "expired-csec",
        expiresAt: "2020-01-01T00:00:00.000Z",
      }),
      "utf-8"
    );

    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "invalid_request" }),
    });

    const { refreshKiroToken } = await import("../../open-sse/services/tokenRefresh/providers.js");
    const expiredResult = await refreshKiroToken("stale-rt-1", {
      authMethod: "idc",
      clientId: "stale-cid",
      clientSecret: "stale-csec",
      region: "us-east-1",
    });
    expect(expiredResult).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Same credentials as failed ones should also skip duplicate retry
    await fs.writeFile(
      path.join(cacheDir, "expired-hash.json"),
      JSON.stringify({
        clientId: "same-cid",
        clientSecret: "same-csec",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
      "utf-8"
    );
    await fs.writeFile(
      path.join(cacheDir, "kiro-auth-token.json"),
      JSON.stringify({
        refreshToken: "same-rt",
        authMethod: "idc",
        region: "us-east-1",
        clientIdHash: "expired-hash",
      }),
      "utf-8"
    );

    const sameResult = await refreshKiroToken("same-rt", {
      authMethod: "idc",
      clientId: "same-cid",
      clientSecret: "same-csec",
      region: "us-east-1",
    });
    expect(sameResult).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers testStatus to active in GET /api/usage/[connectionId] when quotas > 0 and cooldown has passed", async () => {
    const pastIso = "2020-01-01T00:00:00.000Z";
    mocks.getProviderConnectionById
      .mockResolvedValueOnce({
        id: "conn-kiro-recover",
        provider: "kiro",
        authType: "oauth",
        testStatus: "unavailable",
        unavailableUntil: pastIso,
        accessToken: "valid-access-token",
        refreshToken: "valid-refresh-token",
        providerSpecificData: { authMethod: "idc", region: "ap-southeast-1" },
      })
      .mockResolvedValueOnce({
        id: "conn-kiro-expired-recover",
        provider: "kiro",
        authType: "oauth",
        testStatus: "expired",
        unavailableUntil: null,
        accessToken: "valid-access-token",
        refreshToken: "valid-refresh-token",
        providerSpecificData: { authMethod: "idc", region: "ap-southeast-1" },
      });

    vi.doMock("open-sse/services/usage.js", () => ({
      getUsageForProvider: vi.fn(async () => ({
        plan: "Kiro Enterprise",
        quotas: {
          agentic_request: { used: 10, total: 100, remaining: 90, unlimited: false },
        },
      })),
    }));
    vi.doMock("open-sse/executors/index.js", () => ({
      getExecutor: vi.fn(() => ({
        needsRefresh: () => false,
        refreshCredentials: vi.fn(async () => null),
      })),
    }));
    vi.doMock("@/lib/network/connectionProxy", () => ({
      resolveConnectionProxyConfig: vi.fn(async () => ({ connectionProxyEnabled: false })),
    }));

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response1 = await GET(new Request("http://localhost/api/usage/conn-kiro-recover"), {
      params: Promise.resolve({ connectionId: "conn-kiro-recover" }),
    });
    expect(response1.status).toBe(200);
    expect(mocks.updateProviderConnection).toHaveBeenNthCalledWith(
      1,
      "conn-kiro-recover",
      expect.objectContaining({
        quotaRemainingPct: 90,
        testStatus: "active",
      })
    );

    const response2 = await GET(new Request("http://localhost/api/usage/conn-kiro-expired-recover"), {
      params: Promise.resolve({ connectionId: "conn-kiro-expired-recover" }),
    });
    expect(response2.status).toBe(200);
    expect(mocks.updateProviderConnection).toHaveBeenNthCalledWith(
      2,
      "conn-kiro-expired-recover",
      expect.objectContaining({
        quotaRemainingPct: 90,
        testStatus: "active",
      })
    );
  });

  it("does not recover testStatus when unavailableUntil is in the future or remaining quota is 0, and merges healed providerSpecificData", async () => {
    const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    mocks.getProviderConnectionById
      .mockResolvedValueOnce({
        id: "conn-future-cooldown",
        provider: "kiro",
        authType: "oauth",
        testStatus: "unavailable",
        unavailableUntil: futureIso,
        accessToken: "valid-at",
        refreshToken: "valid-rt",
        providerSpecificData: { authMethod: "idc" },
      })
      .mockResolvedValueOnce({
        id: "conn-zero-quota",
        provider: "kiro",
        authType: "oauth",
        testStatus: "unavailable",
        unavailableUntil: null,
        accessToken: "valid-at",
        refreshToken: "valid-rt",
        providerSpecificData: { authMethod: "idc" },
      });

    const getUsageMock = vi
      .fn()
      .mockResolvedValueOnce({
        quotas: { agentic_request: { used: 20, total: 100, remaining: 80, unlimited: false } },
      })
      .mockResolvedValueOnce({
        quotas: { agentic_request: { used: 100, total: 100, remaining: 0, unlimited: false } },
      });

    vi.doMock("open-sse/services/usage.js", () => ({
      getUsageForProvider: getUsageMock,
    }));
    vi.doMock("open-sse/executors/index.js", () => ({
      getExecutor: vi.fn(() => ({
        needsRefresh: (creds) => creds.connectionId === "conn-future-cooldown",
        refreshCredentials: vi.fn(async () => ({
          accessToken: "refreshed-at",
          refreshToken: "refreshed-rt",
          expiresIn: 3600,
          providerSpecificData: {
            clientId: "healed-cid",
            clientSecret: "healed-csec",
            clientSecretExpiresAt: "2027-01-01T00:00:00.000Z",
          },
        })),
      })),
    }));
    vi.doMock("@/lib/network/connectionProxy", () => ({
      resolveConnectionProxyConfig: vi.fn(async () => ({ connectionProxyEnabled: false })),
    }));

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response1 = await GET(new Request("http://localhost/api/usage/conn-future-cooldown"), {
      params: Promise.resolve({ connectionId: "conn-future-cooldown" }),
    });
    expect(response1.status).toBe(200);
    // First update persists merged providerSpecificData from refreshAndUpdateCredentials
    expect(mocks.updateProviderConnection).toHaveBeenNthCalledWith(
      1,
      "conn-future-cooldown",
      expect.objectContaining({
        accessToken: "refreshed-at",
        refreshToken: "refreshed-rt",
        providerSpecificData: {
          authMethod: "idc",
          clientId: "healed-cid",
          clientSecret: "healed-csec",
          clientSecretExpiresAt: "2027-01-01T00:00:00.000Z",
        },
      })
    );
    // Second update persists quota snapshot without forcing testStatus active during cooldown
    expect(mocks.updateProviderConnection).toHaveBeenNthCalledWith(
      2,
      "conn-future-cooldown",
      expect.not.objectContaining({ testStatus: "active" })
    );

    const response2 = await GET(new Request("http://localhost/api/usage/conn-zero-quota"), {
      params: Promise.resolve({ connectionId: "conn-zero-quota" }),
    });
    expect(response2.status).toBe(200);
    expect(mocks.updateProviderConnection).toHaveBeenNthCalledWith(
      3,
      "conn-zero-quota",
      expect.objectContaining({ quotaRemainingPct: 0 })
    );
    expect(mocks.updateProviderConnection).toHaveBeenNthCalledWith(
      3,
      "conn-zero-quota",
      expect.not.objectContaining({ testStatus: "active" })
    );
  });

  it("auto-imports aorAAA Kiro tokens with clientSecretExpiresAt and persists normalized expiry on import", async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "kiro-auto-import-"));
    tempDirs.push(cacheDir);
    process.env.AWS_SSO_CACHE_DIR = cacheDir;

    const futureIso = "2027-03-01T12:00:00.000Z";
    await fs.writeFile(
      path.join(cacheDir, "kiro-auth-token.json"),
      JSON.stringify({
        refreshToken: "aorAAAShortPrefixToken",
        authMethod: "IdC",
        region: "ap-southeast-1",
        clientIdHash: "idc-client-1",
      }),
      "utf-8"
    );
    await fs.writeFile(
      path.join(cacheDir, "idc-client-1.json"),
      JSON.stringify({
        clientId: "auto-cid",
        clientSecret: "auto-csec",
        expiresAt: futureIso,
      }),
      "utf-8"
    );

    const { GET: autoImportGet } = await import("../../src/app/api/oauth/kiro/auto-import/route.js");
    const autoRes = await autoImportGet();
    expect(autoRes.status).toBe(200);
    const autoBody = await autoRes.json();
    expect(autoBody).toMatchObject({
      found: true,
      refreshToken: "aorAAAShortPrefixToken",
      clientId: "auto-cid",
      clientSecret: "auto-csec",
      clientSecretExpiresAt: futureIso,
      region: "ap-southeast-1",
      authMethod: "IdC",
    });

    vi.doMock("@/models", () => ({
      createProviderConnection: mocks.createProviderConnection,
    }));
    vi.doMock("@/lib/oauth/services/kiro", () => ({
      KiroService: class MockKiroService {
        async refreshToken() {
          return {
            accessToken: "imported-at",
            refreshToken: "imported-rt",
            expiresIn: 3600,
          };
        }
        extractEmailFromJWT() {
          return "user@corp.example";
        }
      },
    }));

    const { POST: importPost } = await import("../../src/app/api/oauth/kiro/import/route.js");
    const epochSec = 1794560400;
    const importRes = await importPost(
      new Request("http://localhost/api/oauth/kiro/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          refreshToken: "aorAAAShortPrefixToken",
          clientId: "auto-cid",
          clientSecret: "auto-csec",
          clientSecretExpiresAt: epochSec,
          region: "ap-southeast-1",
          authMethod: "IdC",
        }),
      })
    );
    expect(importRes.status).toBe(200);
    expect(mocks.createProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "kiro",
        providerSpecificData: expect.objectContaining({
          authMethod: "idc",
          clientId: "auto-cid",
          clientSecret: "auto-csec",
          clientSecretExpiresAt: new Date(epochSec * 1000).toISOString(),
          region: "ap-southeast-1",
        }),
      })
    );
  });
});
