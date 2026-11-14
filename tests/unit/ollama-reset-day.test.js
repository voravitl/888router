import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeProviderSpecificData, parseOllamaResetDay } from "@/lib/providerNormalization";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => []),
  getProviderConnectionById: vi.fn(async () => null),
  getProxyPoolById: vi.fn(async () => null),
  updateProviderConnection: vi.fn(async (_id, data) => ({ id: "conn-ollama-1", ...data })),
  deleteProviderConnection: vi.fn(async () => true),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  getProxyPoolById: mocks.getProxyPoolById,
  updateProviderConnection: mocks.updateProviderConnection,
  deleteProviderConnection: mocks.deleteProviderConnection,
}));

describe("Ollama billing resetDay normalization, client projection, and update route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-ollama-1",
      provider: "ollama",
      authType: "apikey",
      name: "Ollama",
      apiKey: "secret-ollama-key",
      providerSpecificData: {
        connectionProxyEnabled: false,
        connectionProxyUrl: "",
        connectionNoProxy: "",
        resetDay: 17,
      },
    });
    mocks.updateProviderConnection.mockImplementation(async (id, updateData) => ({
      id,
      provider: "ollama",
      authType: "apikey",
      name: "Ollama",
      apiKey: "secret-ollama-key",
      ...updateData,
    }));
  });

  it("parses valid resetDay values (1-31) and rejects invalid values", () => {
    expect(parseOllamaResetDay(1)).toBe(1);
    expect(parseOllamaResetDay(21)).toBe(21);
    expect(parseOllamaResetDay(31)).toBe(31);
    expect(parseOllamaResetDay("1")).toBe(1);
    expect(parseOllamaResetDay(" 21 ")).toBe(21);
    expect(parseOllamaResetDay("31")).toBe(31);

    for (const invalid of [undefined, null, "", "   ", 0, 32, -1, 17.5, "0", "32", "abc", "17.5"]) {
      expect(parseOllamaResetDay(invalid)).toBeNull();
    }
  });

  it("normalizes resetDay in normalizeProviderSpecificData('ollama', ...)", () => {
    expect(
      normalizeProviderSpecificData("ollama", {}, { resetDay: "21" })
    ).toEqual({ resetDay: 21 });

    expect(
      normalizeProviderSpecificData("ollama", { resetDay: 5 }, null)
    ).toEqual({ resetDay: 5 });

    expect(
      normalizeProviderSpecificData("ollama", {}, { resetDay: "0", proxyPoolId: "pool-1" })
    ).toEqual({ proxyPoolId: "pool-1" });

    expect(
      normalizeProviderSpecificData("ollama", {}, { resetDay: "" })
    ).toBeNull();
  });

  it("exposes providerSpecificData.resetDay in GET /api/providers/client without leaking credentials", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-ollama-1",
        provider: "ollama",
        authType: "apikey",
        name: "Ollama",
        isActive: true,
        testStatus: "unavailable",
        apiKey: "secret-ollama-key",
        providerSpecificData: {
          resetDay: 21,
          consoleCookie: "secret-cookie",
        },
      },
    ]);

    const { GET } = await import("../../src/app/api/providers/client/route.js");
    const response = await GET(new Request("http://localhost/api/providers/client?provider=ollama"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.connections).toHaveLength(1);
    const conn = body.connections[0];
    expect(conn.providerSpecificData.resetDay).toBe(21);
    expect(conn.providerSpecificData.consoleCookie).toBeUndefined();
    expect(conn.apiKey).toBeUndefined();
  });

  it("coerces valid resetDay and preserves existing metadata in PUT /api/providers/[id]", async () => {
    const { PUT } = await import("../../src/app/api/providers/[id]/route.js");
    const req = new Request("http://localhost/api/providers/conn-ollama-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerSpecificData: { resetDay: "21" },
      }),
    });

    const response = await PUT(req, { params: Promise.resolve({ id: "conn-ollama-1" }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      "conn-ollama-1",
      expect.objectContaining({
        providerSpecificData: expect.objectContaining({
          connectionProxyEnabled: false,
          resetDay: 21,
        }),
      })
    );
    expect(body.connection.providerSpecificData.resetDay).toBe(21);
    expect(body.connection.apiKey).toBeUndefined();
  });

  it("clears resetDay when empty string or null is sent to PUT /api/providers/[id]", async () => {
    const { PUT } = await import("../../src/app/api/providers/[id]/route.js");
    for (const emptyValue of [null, ""]) {
      const req = new Request("http://localhost/api/providers/conn-ollama-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerSpecificData: { resetDay: emptyValue },
        }),
      });

      const response = await PUT(req, { params: Promise.resolve({ id: "conn-ollama-1" }) });
      expect(response.status).toBe(200);
      const lastCall = mocks.updateProviderConnection.mock.calls.at(-1);
      expect(lastCall[1].providerSpecificData).not.toHaveProperty("resetDay");
    }
  });

  it("preserves existing resetDay when PUT /api/providers/[id] updates unrelated fields", async () => {
    const { PUT } = await import("../../src/app/api/providers/[id]/route.js");
    const req = new Request("http://localhost/api/providers/conn-ollama-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ollama Renamed" }),
    });

    const response = await PUT(req, { params: Promise.resolve({ id: "conn-ollama-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      "conn-ollama-1",
      expect.objectContaining({
        name: "Ollama Renamed",
        providerSpecificData: expect.objectContaining({
          resetDay: 17,
        }),
      })
    );
  });

  it.each([0, 32, "abc", 17.5])(
    "rejects out-of-range or non-integer resetDay (%s) with HTTP 400",
    async (badResetDay) => {
      const { PUT } = await import("../../src/app/api/providers/[id]/route.js");
      const req = new Request("http://localhost/api/providers/conn-ollama-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerSpecificData: { resetDay: badResetDay },
        }),
      });

      const response = await PUT(req, { params: Promise.resolve({ id: "conn-ollama-1" }) });
      expect(response.status).toBe(400);
      expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
    }
  );
});
