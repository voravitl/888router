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
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-activity-"));
      process.env.DATA_DIR = tempDir;
      try { global._dbAdapter?.instance?.close?.(); } catch {}
      delete global._dbAdapter;
      delete global._recentErrorActivity;
      delete global._lastGatewayAttemptAt;
    });

    afterEach(() => {
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
  });
});
