import { describe, it, expect, beforeEach, vi } from "vitest";

// Regression test for the Kiro model-sync profileArn bug: ListAvailableModels
// was called with no fallback profileArn when a connection had none stored,
// causing AWS to return AccessDeniedException ("Your subscription does not
// support this application"). Chat requests (claude-to-kiro.js/openai-to-kiro.js)
// and usage lookups (usage/kiro.js) already fall back to the shared default
// profileArn for OAuth/social auth (never for api_key, which gets a 403 on the
// shared ARN) — the models route must apply the same resolution.

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  listAvailableModels: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
}));

vi.mock("@/lib/oauth/services/kiro", () => ({
  KiroService: vi.fn().mockImplementation(function () {
    this.listAvailableModels = mocks.listAvailableModels;
  }),
}));

vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshGoogleToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
  refreshKiroToken: vi.fn().mockResolvedValue(null),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

describe("Kiro models route — profileArn resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAvailableModels.mockResolvedValue([{ id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" }]);
  });

  it("falls back to the shared default profileArn for builder-id auth with no stored ARN", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-kiro-1",
      provider: "kiro",
      accessToken: "kiro-access-token",
      providerSpecificData: { authMethod: "builder-id" },
    });

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");

    const res = await GET(new Request("http://localhost/api/providers/conn-kiro-1/models"), {
      params: Promise.resolve({ id: "conn-kiro-1" }),
    });
    const body = await res.json();

    expect(mocks.listAvailableModels).toHaveBeenCalledWith(
      "kiro-access-token",
      "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX",
    );
    expect(body.models).toHaveLength(1);
  });

  it("falls back to the social default profileArn for google/github auth with no stored ARN", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-kiro-2",
      provider: "kiro",
      accessToken: "kiro-access-token",
      providerSpecificData: { authMethod: "google" },
    });

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");

    const res = await GET(new Request("http://localhost/api/providers/conn-kiro-2/models"), {
      params: Promise.resolve({ id: "conn-kiro-2" }),
    });
    await res.json();

    expect(mocks.listAvailableModels).toHaveBeenCalledWith(
      "kiro-access-token",
      "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK",
    );
  });

  it("never uses the shared default profileArn for api_key auth (would 403)", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-kiro-3",
      provider: "kiro",
      accessToken: "kiro-api-key",
      providerSpecificData: { authMethod: "api_key" },
    });

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");

    const res = await GET(new Request("http://localhost/api/providers/conn-kiro-3/models"), {
      params: Promise.resolve({ id: "conn-kiro-3" }),
    });
    await res.json();

    expect(mocks.listAvailableModels).toHaveBeenCalledWith("kiro-api-key", "");
  });

  it("degrades to the built-in Kiro catalog with a friendly warning when AWS blocks ListAvailableModels", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-kiro-idc",
      provider: "kiro",
      accessToken: "kiro-access-token",
      providerSpecificData: { authMethod: "idc" },
    });
    mocks.listAvailableModels.mockRejectedValue(new Error(
      'Failed to list models: {"__type":"com.amazon.aws.codewhisperer#AccessDeniedException","message":"Your subscription does not support this application. Please contact your administrator."}',
    ));

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");

    const res = await GET(new Request("http://localhost/api/providers/conn-kiro-idc/models"), {
      params: Promise.resolve({ id: "conn-kiro-idc" }),
    });
    const body = await res.json();

    // Built-in catalog returned (not empty), and the raw AWS JSON is NOT surfaced.
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models.some((m) => m.id === "claude-sonnet-4.5")).toBe(true);
    expect(body.warning).toMatch(/can't list models dynamically/i);
    expect(body.warning).not.toMatch(/AccessDeniedException/);
  });

  it("uses the connection's own stored profileArn when present, regardless of authMethod", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-kiro-4",
      provider: "kiro",
      accessToken: "kiro-access-token",
      providerSpecificData: {
        authMethod: "builder-id",
        profileArn: "arn:aws:codewhisperer:us-east-1:111111111111:profile/OWNPROFILE",
      },
    });

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");

    const res = await GET(new Request("http://localhost/api/providers/conn-kiro-4/models"), {
      params: Promise.resolve({ id: "conn-kiro-4" }),
    });
    await res.json();

    expect(mocks.listAvailableModels).toHaveBeenCalledWith(
      "kiro-access-token",
      "arn:aws:codewhisperer:us-east-1:111111111111:profile/OWNPROFILE",
    );
  });
});
