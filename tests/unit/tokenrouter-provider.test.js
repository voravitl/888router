import { describe, it, expect } from "vitest";
import tokenrouter from "../../open-sse/providers/registry/tokenrouter.js";
import { APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";

describe("TokenRouter Provider Registry & Integration", () => {
  it("has valid category and display icon in registry definition", () => {
    expect(tokenrouter.id).toBe("tokenrouter");
    expect(tokenrouter.category).toBe("apikey");
    expect(tokenrouter.display.name).toBe("TokenRouter");
    expect(tokenrouter.display.icon).toBe("tokenrouter");
    expect(tokenrouter.transport.baseUrl).toBe("https://api.tokenrouter.com/v1/chat/completions");
  });

  it("registers in APIKEY_PROVIDERS map", () => {
    expect(APIKEY_PROVIDERS.tokenrouter).toBeDefined();
    expect(APIKEY_PROVIDERS.tokenrouter.id).toBe("tokenrouter");
  });

  it("exposes modelsFetcher for dynamic model listing", () => {
    expect(tokenrouter.modelsFetcher).toMatchObject({
      url: "https://api.tokenrouter.com/v1/models",
      type: "openai",
    });
  });
});
