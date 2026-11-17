import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const readRepoFile = (relPath) =>
  fs.readFileSync(fileURLToPath(new URL(`../../${relPath}`, import.meta.url)), "utf8");

describe("Hermes compatibility & 10-Minute Gateway Activity telemetry", () => {
  it("detectClientTool detects Hermes Agent without disturbing Claude/Codex/Copilot detection", async () => {
    const { detectClientTool, isNativePassthrough } = await import("../../open-sse/utils/clientDetector.js");

    expect(detectClientTool({ "user-agent": "HermesAgent/0.14.0" }, {})).toBe("hermes");
    expect(detectClientTool({ "x-title": "Hermes Agent" }, {})).toBe("hermes");
    expect(detectClientTool({ originator: "hermes-agent" }, {})).toBe("hermes");
    expect(isNativePassthrough("hermes", "claude")).toBe(false);

    // Existing client detectors remain intact
    expect(detectClientTool({ "user-agent": "claude-cli/2.1.0" }, {})).toBe("claude");
    expect(detectClientTool({ "user-agent": "codex-tui/1.0" }, {})).toBe("codex");
  });

  it("HyperionBentoHero includes Hermes SDK quickstart tab, idle guidance, and 24h fallback pulse", () => {
    const src = readRepoFile("src/app/(dashboard)/dashboard/endpoint/components/HyperionBentoHero.js");
    expect(src).toMatch(/label:\s*["']Hermes["'][\s\S]*value:\s*["']hermes["']/);
    expect(src).toContain("session_affinity_header");
    expect(src).toContain("x-session-id");
    expect(src).toMatch(/No requests in last 10m/i);
    expect(src).toMatch(/activityMode|24h/i);
    expect(src).toContain("/api/usage/chart");
  });

  it("usage/stream SSE route sets X-Accel-Buffering: no and keeps last10Minutes fresh", () => {
    const src = readRepoFile("src/app/api/usage/stream/route.js");
    expect(src).toContain('"X-Accel-Buffering": "no"');
    expect(src).toContain("no-transform");
    expect(src).toMatch(/setInterval\(/);
  });

  it("HermesToolCard & hermes-settings support named providers.888router (custom:888router) and session_affinity_header", () => {
    const routeSrc = readRepoFile("src/app/api/cli-tools/hermes-settings/route.js");
    const cardSrc = readRepoFile("src/app/(dashboard)/dashboard/cli-tools/components/HermesToolCard.js");

    expect(routeSrc).toContain("custom:888router");
    expect(routeSrc).toContain("session_affinity_header");
    expect(cardSrc).toContain("custom:888router");
    expect(cardSrc).toContain("session_affinity_header");
  });

  describe("10-minute telemetry includes error attempts & lastActivityAt in usageRepo", () => {
    const originalDataDir = process.env.DATA_DIR;
    let tempDir;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 10, 17, 14, 30, 15, 0));
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-activity-"));
      process.env.DATA_DIR = tempDir;
      try { global._dbAdapter?.instance?.close?.(); } catch {}
      delete global._dbAdapter;
      delete global._recentErrorActivity;
      delete global._lastGatewayAttemptAt;
    });

    afterEach(() => {
      vi.useRealTimers();
      try { global._dbAdapter?.instance?.close?.(); } catch {}
      delete global._dbAdapter;
      delete global._recentErrorActivity;
      delete global._lastGatewayAttemptAt;
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
    });

    it("surfaces recent error attempts and lastActivityAt in getUsageStats and getActiveRequests", async () => {
      vi.resetModules();
      const db = await import("../../src/lib/db/index.js");
      await db.initDb();

      // Record one failed request attempt via trackPendingRequest error completion
      db.trackPendingRequest("deepseek-v4.1-flash", "opencode-go", "conn-1", true);
      db.trackPendingRequest("deepseek-v4.1-flash", "opencode-go", "conn-1", false, true);

      const active = await db.getActiveRequests();
      expect(Array.isArray(active.last10Minutes)).toBe(true);
      expect(active.last10Minutes).toHaveLength(10);
      expect(active.last10Minutes[9].errors).toBe(1);
      expect(active.lastActivityAt).toBeTruthy();

      const stats = await db.getUsageStats("7d");
      expect(stats.last10Minutes[9].errors).toBe(1);
      expect(stats.lastActivityAt).toBeTruthy();
    });

    it("deduplicates SQL requestDetails errors vs in-memory recentErrorActivity and updates lastActivityAt on saveRequestUsage", async () => {
      vi.resetModules();
      const db = await import("../../src/lib/db/index.js");
      const { getAdapter } = await import("../../src/lib/db/driver.js");
      const { computeLast10MinutesActivity } = await import("../../src/lib/db/repos/usageRepo.js");
      await db.initDb();

      const adapter = await getAdapter();
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const twoMinAgoIso = new Date(nowMs - 2 * 60 * 1000).toISOString();

      // 1 error in-memory + matching 1 error in requestDetails in current minute -> must NOT double-count
      db.trackPendingRequest("gpt-5", "openai", "conn-1", true);
      db.trackPendingRequest("gpt-5", "openai", "conn-1", false, true);
      adapter.run(
        `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
        ["err-now", nowIso, "openai", "gpt-5", "conn-1", "error", "{}"]
      );
      // Non-error statuses in requestDetails must be ignored
      adapter.run(
        `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
        ["ok-now", nowIso, "openai", "gpt-5", "conn-1", "success", "{}"]
      );
      adapter.run(
        `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
        ["empty-now", nowIso, "openai", "gpt-5", "conn-1", "empty", "{}"]
      );
      // Historical SQL-only error 2 minutes ago
      adapter.run(
        `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
        ["err-2m", twoMinAgoIso, "openai", "gpt-5", "conn-1", "error", "{}"]
      );

      const computed = computeLast10MinutesActivity(adapter, nowMs);
      expect(computed.last10Minutes[9].errors).toBe(1);
      expect(computed.last10Minutes[7].errors).toBe(1);

      const active = await db.getActiveRequests();
      expect(active.last10Minutes[9].errors).toBe(1);
      expect(active.last10Minutes[7].errors).toBe(1);

      const stats = await db.getUsageStats("24h");
      expect(stats.last10Minutes[9].errors).toBe(1);
      expect(stats.last10Minutes[7].errors).toBe(1);

      // saveRequestUsage updates global._lastGatewayAttemptAt and lastActivityAt
      const futureAttemptIso = new Date(Date.now() + 5000).toISOString();
      await db.saveRequestUsage({
        timestamp: futureAttemptIso,
        provider: "openai",
        model: "gpt-5",
        connectionId: "conn-1",
        tokens: { prompt_tokens: 12, completion_tokens: 8 },
        status: "ok",
      });
      expect(global._lastGatewayAttemptAt).toBe(futureAttemptIso);
      const afterWrite = await db.getActiveRequests();
      expect(afterWrite.lastActivityAt).toBe(futureAttemptIso);
    });

    it("getChartData('24h') and getChartData('today') return requests and deduplicated errors", async () => {
      vi.resetModules();
      const db = await import("../../src/lib/db/index.js");
      const { getAdapter } = await import("../../src/lib/db/driver.js");
      await db.initDb();
      const adapter = await getAdapter();

      const now = Date.now();
      const recentIso = new Date(now - 30 * 1000).toISOString();

      await db.saveRequestUsage({
        timestamp: recentIso,
        provider: "openai",
        model: "gpt-5",
        connectionId: "conn-1",
        tokens: { prompt_tokens: 100, completion_tokens: 50 },
        status: "ok",
      });

      // Record both in-memory error and SQL requestDetails error in the current hour bucket
      db.trackPendingRequest("gpt-5", "openai", "conn-1", true);
      db.trackPendingRequest("gpt-5", "openai", "conn-1", false, true);
      adapter.run(
        `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
        ["chart-err-1", recentIso, "openai", "gpt-5", "conn-1", "error", "{}"]
      );
      adapter.run(
        `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
        ["chart-ok-1", recentIso, "openai", "gpt-5", "conn-1", "success", "{}"]
      );
      adapter.run(
        `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
        ["chart-empty-1", recentIso, "openai", "gpt-5", "conn-1", "empty", "{}"]
      );

      const chart24h = await db.getChartData("24h");
      expect(chart24h).toHaveLength(24);
      expect(chart24h[0]).toMatchObject({ tokens: 0, cost: 0, requests: 0, errors: 0 });
      expect(chart24h[23].requests).toBe(1);
      expect(chart24h[23].errors).toBe(1);
      expect(chart24h[23].tokens).toBe(150);

      const chartToday = await db.getChartData("today");
      expect(chartToday).toHaveLength(24);
      const currentHour = new Date().getHours();
      expect(chartToday[currentHour].requests).toBe(1);
      expect(chartToday[currentHour].errors).toBe(1);
      expect(chartToday[currentHour].tokens).toBe(150);

      // Should still succeed if requestDetails table does not exist
      adapter.run(`DROP TABLE requestDetails`);
      const chartWithoutRd = await db.getChartData("24h");
      expect(chartWithoutRd).toHaveLength(24);
      expect(chartWithoutRd[23].requests).toBe(1);
      expect(chartWithoutRd[23].errors).toBe(1);
    });
  });

  describe("hermes-settings route GET / POST / DELETE behavior", () => {
    const originalHome = process.env.HOME;
    let tempHome;

    beforeEach(() => {
      tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-home-"));
      process.env.HOME = tempHome;
    });

    afterEach(() => {
      vi.restoreAllMocks();
      if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    });

    it("POST preserves unrelated YAML & providers.888router.models, GET detects HTTPS tunnels, DELETE resets cleanly", async () => {
      vi.resetModules();
      vi.spyOn(os, "homedir").mockReturnValue(tempHome);

      const hermesDir = path.join(tempHome, ".hermes");
      const configPath = path.join(hermesDir, "config.yaml");
      const envPath = path.join(hermesDir, ".env");
      fs.mkdirSync(hermesDir, { recursive: true });

      const initialYaml = [
        "terminal:",
        "  backend: local",
        "",
        "providers:",
        "  openrouter:",
        '    base_url: "https://openrouter.ai/api/v1"',
        "  888router:",
        '    base_url: "http://localhost:20128/v1"',
        "    models:",
        "      ag/gemini-3-pro:",
        "        context_length: 1000000",
        "      ag/claude-sonnet-4-6:",
        "        context_length: 200000",
        "",
        "web:",
        "  backend: duckduckgo",
        "",
      ].join("\n");
      fs.writeFileSync(configPath, initialYaml, "utf8");

      const { GET, POST, DELETE } = await import("../../src/app/api/cli-tools/hermes-settings/route.js");

      // 1. POST local URL without /v1 -> writes custom:888router + session_affinity_header and preserves models + unrelated blocks
      const postLocalRes = await POST(
        new Request("http://localhost/api/cli-tools/hermes-settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseUrl: "http://127.0.0.1:20129",
            apiKey: "sk_test_hermes_123",
            model: "ag/gemini-3-pro",
          }),
        })
      );
      expect(postLocalRes.status).toBe(200);

      const yamlAfterLocal = fs.readFileSync(configPath, "utf8");
      expect(yamlAfterLocal).toContain('provider: "custom:888router"');
      expect(yamlAfterLocal).toContain('base_url: "http://127.0.0.1:20129/v1"');
      expect(yamlAfterLocal).toContain('session_affinity_header: "x-session-id"');
      expect(yamlAfterLocal).toContain("ag/gemini-3-pro:");
      expect(yamlAfterLocal).toContain("context_length: 1000000");
      expect(yamlAfterLocal).toContain("ag/claude-sonnet-4-6:");
      expect(yamlAfterLocal).toContain("terminal:\n  backend: local");
      expect(yamlAfterLocal).toContain("openrouter:");
      expect(yamlAfterLocal).toContain("web:\n  backend: duckduckgo");
      expect(fs.readFileSync(envPath, "utf8")).toContain("OPENAI_API_KEY=sk_test_hermes_123");

      const getLocalJson = await (await GET()).json();
      expect(getLocalJson.installed).toBe(true);
      expect(getLocalJson.has9Router).toBe(true);
      expect(getLocalJson.settings.model.provider).toBe("custom:888router");
      expect(getLocalJson.settings.providers["888router"].session_affinity_header).toBe("x-session-id");
      expect(getLocalJson.settings.providers["888router"].modelsRaw).toContain("ag/claude-sonnet-4-6:");

      // 2. POST HTTPS tunnel URL with trailing slash -> normalizes cleanly without //v1 and GET recognizes has9Router: true
      const postTunnelRes = await POST(
        new Request("http://localhost/api/cli-tools/hermes-settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseUrl: "https://tunnel-gateway.example.com/",
            model: "ag/claude-opus-4-6",
          }),
        })
      );
      expect(postTunnelRes.status).toBe(200);

      const yamlAfterTunnel = fs.readFileSync(configPath, "utf8");
      expect(yamlAfterTunnel).toContain('base_url: "https://tunnel-gateway.example.com/v1"');
      expect(yamlAfterTunnel).not.toContain("//v1");
      expect(yamlAfterTunnel).toContain("ag/claude-sonnet-4-6:");

      const getTunnelJson = await (await GET()).json();
      expect(getTunnelJson.has9Router).toBe(true);
      expect(getTunnelJson.settings.model.base_url).toBe("https://tunnel-gateway.example.com/v1");
      expect(getTunnelJson.settings.providers["888router"].base_url).toBe("https://tunnel-gateway.example.com/v1");

      // 3. DELETE resets model & providers.888router while preserving unrelated YAML blocks and openrouter
      const delRes = await DELETE();
      expect(delRes.status).toBe(200);

      const yamlAfterDelete = fs.readFileSync(configPath, "utf8");
      expect(yamlAfterDelete).not.toContain("888router:");
      expect(yamlAfterDelete).not.toContain("custom:888router");
      expect(yamlAfterDelete).toContain("terminal:\n  backend: local");
      expect(yamlAfterDelete).toContain("openrouter:");
      expect(yamlAfterDelete).toContain("web:\n  backend: duckduckgo");

      const getAfterDelete = await (await GET()).json();
      expect(getAfterDelete.installed).toBe(true);
      expect(getAfterDelete.has9Router).toBe(false);
      expect(getAfterDelete.settings.model).toBeNull();
      expect(getAfterDelete.settings.providers).toEqual({});

      // 4. Unrelated custom provider (non-888router hostname) reports has9Router: false
      fs.writeFileSync(
        configPath,
        'model:\n  default: "llama-3"\n  provider: "custom"\n  base_url: "https://api.together.xyz/v1"\n',
        "utf8"
      );
      const getOtherJson = await (await GET()).json();
      expect(getOtherJson.has9Router).toBe(false);

      // 5. providers: {} with YAML sequence models list & providers.888router-only /v1 URL
      fs.writeFileSync(
        configPath,
        [
          "providers: {}",
          "web:",
          "  backend: duckduckgo",
          "",
        ].join("\n"),
        "utf8"
      );
      const postOverEmptyProviders = await POST(
        new Request("http://localhost/api/cli-tools/hermes-settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseUrl: "https://custom-proxy.example.com/v1",
            model: "ag/gemini-3-pro",
          }),
        })
      );
      expect(postOverEmptyProviders.status).toBe(200);
      const yamlOverEmpty = fs.readFileSync(configPath, "utf8");
      expect(yamlOverEmpty.match(/^providers:/gm)).toHaveLength(1);
      expect(yamlOverEmpty).toContain("web:\n  backend: duckduckgo");

      // Preserve YAML list-style providers.888router.models and detect /v1-ending providers.888router even without custom:888router model
      fs.writeFileSync(
        configPath,
        [
          "providers:",
          "  888router:",
          '    base_url: "https://edge.example.com/v1"',
          "    models:",
          '    - "ag/gemini-3-pro"',
          '    - "ag/claude-sonnet-4-6"',
          "",
        ].join("\n"),
        "utf8"
      );
      const getProviderOnlyJson = await (await GET()).json();
      expect(getProviderOnlyJson.has9Router).toBe(true);
      expect(getProviderOnlyJson.settings.providers["888router"].modelsRaw).toContain('- "ag/claude-sonnet-4-6"');

      const postListRes = await POST(
        new Request("http://localhost/api/cli-tools/hermes-settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseUrl: "https://edge.example.com/v1/",
            model: "ag/gemini-3-pro",
          }),
        })
      );
      expect(postListRes.status).toBe(200);
      const yamlAfterListPost = fs.readFileSync(configPath, "utf8");
      expect(yamlAfterListPost).toContain('- "ag/claude-sonnet-4-6"');
      expect(yamlAfterListPost).toContain('base_url: "https://edge.example.com/v1"');

      // 6. POST validation rejects empty baseUrl/model with 400
      const badPostRes = await POST(
        new Request("http://localhost/api/cli-tools/hermes-settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ baseUrl: "  ", model: "" }),
        })
      );
      expect(badPostRes.status).toBe(400);
    });
  });
});
