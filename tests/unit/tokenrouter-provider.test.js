import { describe, it, expect } from "vitest";
import tokenrouter from "../../open-sse/providers/registry/tokenrouter.js";
import { APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

describe("TokenRouter Provider Registry & Integration", () => {
  it("has valid category and display icon in registry definition", () => {
    expect(tokenrouter.id).toBe("tokenrouter");
    expect(tokenrouter.category).toBe("apikey");
    expect(tokenrouter.display.name).toBe("TokenRouter");
    expect(tokenrouter.display.icon).toBe("router");
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

  it("ensures venice provider is not regressed in provider registry and config", () => {
    const venice = APIKEY_PROVIDERS.venice;
    expect(venice).toBeDefined();
    expect(venice.id).toBe("venice");
  });

  it("deduplicates Anthropic-Beta header flags in DefaultExecutor buildHeaders", () => {
    const executor = new DefaultExecutor("claude", { baseUrl: "https://api.anthropic.com" });
    const headers = executor.buildHeaders({ apiKey: "sk-test" }, true, "claude-opus-5");
    const betaStr = headers["Anthropic-Beta"] || headers["anthropic-beta"];
    const flags = betaStr.split(",").map((s) => s.trim());
    const uniqueFlags = new Set(flags);
    expect(flags.length).toBe(uniqueFlags.size);
  });
});
