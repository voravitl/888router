import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const readRepoFile = (relPath) =>
  readFileSync(fileURLToPath(new URL(`../../${relPath}`, import.meta.url)), "utf8");

const RETIRED_UI_FILES = [
  "src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js",
  "src/app/(dashboard)/dashboard/usage/components/OptimizationSavings.js",
  "src/app/(dashboard)/dashboard/usage/components/RequestDetailsTab.js",
  "src/app/(dashboard)/dashboard/basic-chat/BasicChatPageClient.js",
  "src/shared/components/CommandPalette.js",
];

const FORBIDDEN_PATTERNS = [
  /Compress context/i,
  /Setup Headroom/i,
  /Headroom Proxy/i,
  /Headroom status/i,
  /Headroom stats/i,
  /Headroom diagnostics/i,
  /via Headroom/i,
  /\/api\/headroom\//,
  /formatHeadroomSavings/,
  /headroom/i,
];

describe("Retired Headroom compression proxy UI guard", () => {
  for (const relPath of RETIRED_UI_FILES) {
    it(`${relPath} contains no Headroom proxy controls, copy, or API calls`, () => {
      const content = readRepoFile(relPath);
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(content, `${relPath} matched ${pattern}`).not.toMatch(pattern);
      }
    });
  }

  it("keeps the unrelated quota-buffer 'headroom' combo routing strategy intact", () => {
    const strategies = readRepoFile("src/shared/constants/comboStrategies.js");
    expect(strategies).toMatch(/id:\s*"headroom"/);
  });
});

const TOKEN_SAVER_UI_FILES = [
  "src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js",
  "src/app/(dashboard)/dashboard/usage/components/OptimizationSavings.js",
];

const RETIRED_NON_SAVER_PATTERNS = [
  /Context Pruner/i,
  /AST Pruner/i,
  /Prune history/i,
  /prunerEnabled/,
  /\bpruner\b/i,
  /tokens pruned/i,
  /Response Cache/i,
  /\bcache\?\.(?:hits|hitRate|requests)\b/,
  /Lazy senior dev/i,
  /PONYTAIL_LEVELS/,
  /ponytailEnabled/,
  /ponytailLevel/,
  /ponytail/i,
  /Compress LLM output/i,
  /CAVEMAN_LEVELS/,
  /WENYAN_LOCALES/,
  /cavemanEnabled/,
  /cavemanLevel/,
  /caveman/i,
];

describe("Token Saver & OptimizationSavings UI cleanup, Prompt Cache & Reasoning Cap", () => {
  for (const relPath of TOKEN_SAVER_UI_FILES) {
    it(`${relPath} removes Pruner, Response Cache, Ponytail, and Caveman UI controls/cards`, () => {
      const content = readRepoFile(relPath);
      for (const pattern of RETIRED_NON_SAVER_PATTERNS) {
        expect(content, `${relPath} matched retired pattern ${pattern}`).not.toMatch(pattern);
      }
    });
  }

  it("TokenSaverClient displays Prompt Cache stats in Snapshot and updates Dual-Average Note", () => {
    const content = readRepoFile("src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js");
    expect(content).toContain("Scanned");
    expect(content).toContain("Prompt Cache");
    expect(content).toContain("RTK Saved Requests");
    expect(content).toMatch(/summary\??\.promptCache/);
    expect(content).toMatch(/cachedTokens/);
    expect(content).toMatch(/pctSaved/);
    expect(content).toMatch(/%\s*reused/);
    expect(content).toContain("Dual-Average Note:");
    expect(content).not.toMatch(/pruning/i);
  });

  it("TokenSaverClient exposes RTK, Cap reasoning effort (Off/Low/Medium), Session Affinity, and Loop Breaker without Caveman", () => {
    const content = readRepoFile("src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js");
    expect(content).toContain("Compress tool output");
    expect(content).toMatch(/lossless JSON/i);
    expect(content).toMatch(/ANSI\/CR/i);

    expect(content).toContain("Cap reasoning effort");
    expect(content).toContain("reasoningEffortCap");
    expect(content).toMatch(/["']off["'][\s\S]*["']Off["']/);
    expect(content).toMatch(/["']low["'][\s\S]*["']Low["']/);
    expect(content).toMatch(/["']medium["'][\s\S]*["']Medium["']/);
    expect(content).toMatch(/fetch\(["']\/api\/settings["']/);
    expect(content).toMatch(/method:\s*["']PATCH["']/);

    expect(content).toContain("sessionAffinityEnabled");
    expect(content).toContain("loopBreakerEnabled");

    const cmdPalette = readRepoFile("src/shared/components/CommandPalette.js");
    expect(cmdPalette).not.toMatch(/\bcaveman\b/i);
    expect(cmdPalette).not.toMatch(/\bponytail\b/i);
  });

  it("Profile/Settings page exposes clear Thai Simple Response Style selector (off / auto / all) with Dark Mode contrast", () => {
    const profileSrc = readRepoFile("src/app/(dashboard)/dashboard/profile/page.js");
    const saverSrc = readRepoFile("src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js");

    expect(profileSrc).toContain("Thai Simple");
    expect(profileSrc).toContain("thaiSimpleMode");
    expect(profileSrc).toMatch(/["']off["']/);
    expect(profileSrc).toMatch(/["']auto["']/);
    expect(profileSrc).toMatch(/["']all["']/);
    expect(profileSrc).toContain("Standard (Auto)");
    expect(profileSrc).toContain("Standard + Hermes");
    expect(profileSrc).toContain("/output-style thai-simple");
    expect(profileSrc).not.toContain("<100k+");
    expect(profileSrc).not.toContain("All + Hermes");

    // Dark Mode contrast guard: --color-primary is white (#fafafa) in .dark, so active pills must never use bg-primary text-white
    expect(profileSrc).not.toMatch(/bg-primary\s+text-white/);
    expect(saverSrc).not.toMatch(/bg-primary\s+text-white/);
  });

  it("OptimizationSavings uses a 2-column grid with Prompt Cache and RTK Compression only", () => {
    const content = readRepoFile("src/app/(dashboard)/dashboard/usage/components/OptimizationSavings.js");
    expect(content).toMatch(/grid-cols-1[^"]*sm:grid-cols-2/);
    expect(content).not.toContain("lg:grid-cols-4");
    expect(content).toContain('title="RTK Compression"');
    expect(content).toContain('title="Prompt Cache"');
    expect(content).toMatch(/rtk\??\.bytesSaved/);
    expect(content).toMatch(/promptCache\??\.cachedTokens/);
    expect(content).toMatch(/promptCache\??\.pctSaved/);
    expect(content).toMatch(/Scanned/);
  });
});
