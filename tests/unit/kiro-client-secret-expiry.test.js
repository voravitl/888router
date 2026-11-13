import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => []),
  updateProviderConnection: vi.fn(async () => ({})),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
}));

function makeJwt(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

describe("Kiro clientSecretExpiresAt persistence and safe client projection", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    mocks.getProviderConnections.mockReset();
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.updateProviderConnection.mockReset();
    vi.stubGlobal("fetch", vi.fn());
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
});
