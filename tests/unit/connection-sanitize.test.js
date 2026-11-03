import { describe, it, expect } from "vitest";
import { stripSensitiveProviderSpecificData } from "@/lib/connectionSanitize.js";

describe("stripSensitiveProviderSpecificData", () => {
  it("removes the console cookie and reports that one is stored", () => {
    const result = stripSensitiveProviderSpecificData({
      id: "c1",
      providerSpecificData: { consoleCookie: "csrf=abc; sec_token=t", proxyPoolId: "p1" },
    });
    expect(result.providerSpecificData).toEqual({ proxyPoolId: "p1" });
    expect(result.hasConsoleCookie).toBe(true);
    expect(JSON.stringify(result)).not.toContain("csrf=abc");
  });

  it("reports false when no cookie is stored, keeping other fields", () => {
    const result = stripSensitiveProviderSpecificData({
      id: "c2",
      providerSpecificData: { region: "sg", proxyPoolId: "p2" },
    });
    expect(result.providerSpecificData).toEqual({ region: "sg", proxyPoolId: "p2" });
    expect(result.hasConsoleCookie).toBe(false);
  });

  it("treats an empty or whitespace cookie as not stored", () => {
    for (const consoleCookie of ["", "   "]) {
      const result = stripSensitiveProviderSpecificData({ providerSpecificData: { consoleCookie } });
      expect(result.hasConsoleCookie).toBe(false);
    }
  });

  it("passes through connections without providerSpecificData", () => {
    const input = { id: "c3", provider: "alitp-intl" };
    expect(stripSensitiveProviderSpecificData(input)).toEqual(input);
  });

  it("tolerates null/non-object input", () => {
    expect(stripSensitiveProviderSpecificData(null)).toBeNull();
    expect(stripSensitiveProviderSpecificData("x")).toBe("x");
  });
});
