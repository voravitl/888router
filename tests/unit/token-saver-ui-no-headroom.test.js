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
