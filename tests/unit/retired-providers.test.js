import { describe, it, expect, vi } from "vitest";
import { PROVIDERS } from "open-sse/config/providers.js";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.js";
import {
  isRetiredProvider,
  retiredProviderMessage,
  RETIRED_PROVIDER_IDS,
} from "../../open-sse/config/retiredProviders.js";
import { HTTP_STATUS } from "../../open-sse/config/runtimeConfig.js";

describe("retired providers (PR #388 Codex HIGH)", () => {
  it("lists duckduckgo-web and its historical aliases", () => {
    expect(RETIRED_PROVIDER_IDS).toEqual(
      expect.arrayContaining(["duckduckgo-web", "ddg-web", "ddgw", "duckchat", "ddg"])
    );
    expect(isRetiredProvider("duckduckgo-web")).toBe(true);
    expect(isRetiredProvider("DDG-WEB")).toBe(true);
    expect(isRetiredProvider("openai")).toBe(false);
  });

  it("is not in the live registry", () => {
    expect(PROVIDERS["duckduckgo-web"]).toBeUndefined();
    expect(hasSpecializedExecutor("duckduckgo-web")).toBe(false);
  });

  it("getExecutor throws 410 before any DefaultExecutor/OpenAI fallback", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      expect(() => getExecutor("duckduckgo-web")).toThrow(/removed/);
      const err = (() => {
        try {
          getExecutor("ddgw");
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(Error);
      expect(err.status).toBe(HTTP_STATUS.GONE);
      expect(err.code).toBe("provider_retired");
      expect(err.message).toBe(retiredProviderMessage("ddgw"));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
