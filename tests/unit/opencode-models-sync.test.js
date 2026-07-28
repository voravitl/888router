import { describe, it, expect } from "vitest";
import { providerSupportsModelSync } from "../../src/shared/constants/providers.js";

describe("OpenCode Model Sync Support", () => {
  it("should confirm providerSupportsModelSync returns true for opencode", () => {
    expect(providerSupportsModelSync("opencode")).toBe(true);
    expect(providerSupportsModelSync("opencode-go")).toBe(true);
  });
});
