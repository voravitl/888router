import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveBaseUrl } from "../../open-sse/handlers/search/callers.js";
import { handleSearchCore } from "../../open-sse/handlers/search/index.js";

const CONFIG = { id: "searxng", baseUrl: "https://searxng.example.com" };

describe("resolveBaseUrl SSRF guard", () => {
  it("uses provider default when no override", async () => {
    expect(await resolveBaseUrl(CONFIG, {})).toBe("https://searxng.example.com");
  });

  it("allows public https override", async () => {
    const params = { providerOptions: { baseUrl: "https://my-searxng.example.com" } };
    expect(await resolveBaseUrl(CONFIG, params)).toBe("https://my-searxng.example.com");
  });

  it("allows public http override", async () => {
    const params = { providerOptions: { baseUrl: "http://searxng.example.net" } };
    expect(await resolveBaseUrl(CONFIG, params)).toBe("http://searxng.example.net");
  });

  it("rejects loopback override", async () => {
    const params = { providerOptions: { baseUrl: "http://127.0.0.1:18999" } };
    await expect(resolveBaseUrl(CONFIG, params)).rejects.toThrow();
  });

  it("rejects private IP override", async () => {
    for (const ip of ["10.0.0.1", "192.168.1.1", "172.16.0.1"]) {
      const params = { providerOptions: { baseUrl: `http://${ip}` } };
      await expect(resolveBaseUrl(CONFIG, params), `should reject ${ip}`).rejects.toThrow();
    }
  });

  it("rejects localhost hostname override", async () => {
    const params = { providerOptions: { baseUrl: "http://localhost:8080" } };
    await expect(resolveBaseUrl(CONFIG, params)).rejects.toThrow();
  });

  it("rejects cloud metadata override", async () => {
    const params = { providerOptions: { baseUrl: "http://169.254.169.254/latest/meta-data" } };
    await expect(resolveBaseUrl(CONFIG, params)).rejects.toThrow();
  });

  it("rejects non-http protocols", async () => {
    for (const proto of ["file:///etc/passwd", "gopher://127.0.0.1:70", "ftp://10.0.0.1"]) {
      const params = { providerOptions: { baseUrl: proto } };
      await expect(resolveBaseUrl(CONFIG, params), `should reject ${proto}`).rejects.toThrow();
    }
  });

  it("rejects DNS-resolving internal override (nip.io)", async () => {
    const params = { providerOptions: { baseUrl: "http://127.0.0.1.nip.io:8080" } };
    await expect(resolveBaseUrl(CONFIG, params)).rejects.toThrow(/hostname resolves to an internal host/);
  });
});

describe("/v1/search SSRF integration (Layer 2 DNS & Layer 3 redirect)", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("rejects nip.io override at search dispatch with HTTP 400", async () => {
    const result = await handleSearchCore({
      body: {
        query: "test search",
        provider_options: { baseUrl: "http://127.0.0.1.nip.io:8080" }
      },
      provider: { id: "searxng", noAuth: true },
      providerConfig: { id: "searxng", baseUrl: "https://searxng.example.com", authType: "none", searchTypes: ["web"] },
      credentials: null,
      log: null
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/internal host/);
  });

  it("rejects 302 redirect to loopback with HTTP 400", async () => {
    // Mock fetch so the initial request returns 302 pointing to 127.0.0.1
    global.fetch = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { Location: "http://127.0.0.1:20128/admin/secret" }
      });
    });

    const result = await handleSearchCore({
      body: {
        query: "test search",
        provider_options: { baseUrl: "https://my-search.example.com" }
      },
      provider: { id: "serper" },
      providerConfig: { id: "serper", baseUrl: "https://google.serper.dev", authType: "apiKey", searchTypes: ["web"] },
      credentials: { apiKey: "dummy-key" },
      log: null
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/internal host/);
  });

  it("allows normal search response from valid public provider", async () => {
    global.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({
        organic: [{ title: "Test Result", link: "https://example.com/1", snippet: "Snippet 1" }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const result = await handleSearchCore({
      body: {
        query: "test search"
      },
      provider: { id: "serper" },
      providerConfig: { id: "serper", baseUrl: "https://google.serper.dev", authType: "apiKey", searchTypes: ["web"] },
      credentials: { apiKey: "dummy-key" },
      log: null
    });

    expect(result.success).toBe(true);
    expect(result.data.results.length).toBe(1);
    expect(result.data.results[0].title).toBe("Test Result");
  });
});
