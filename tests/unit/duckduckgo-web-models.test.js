import { describe, it, expect } from "vitest";
import duckduckgoWebConfig from "open-sse/providers/registry/duckduckgo-web.js";
import { isPublicModelsProvider } from "@/shared/constants/providers.js";

describe("DuckDuckGo Web Provider & Models", () => {
  it("duckduckgo-web has valid no-auth configuration", () => {
    expect(duckduckgoWebConfig.id).toBe("duckduckgo-web");
    expect(duckduckgoWebConfig.authType).toBe("none");
    expect(duckduckgoWebConfig.hasFree).toBe(true);
  });

  it("duckduckgo-web is recognized as a public models provider", () => {
    expect(isPublicModelsProvider("duckduckgo-web")).toBe(true);
  });

  it("duckduckgo-web registers active AI chat models with context lengths", () => {
    const ids = duckduckgoWebConfig.models.map((m) => m.id);
    expect(ids).toContain("gpt-4o-mini");
    expect(ids).toContain("claude-3-haiku-20240307");
    expect(ids).toContain("meta-llama/Llama-3.3-70B-Instruct-Turbo");
    expect(ids).toContain("mistralai/Mistral-Small-24B-Instruct-2501");
    expect(ids).toContain("o3-mini");

    const haiku = duckduckgoWebConfig.models.find((m) => m.id === "claude-3-haiku-20240307");
    expect(haiku.contextLength).toBe(200000);
  });
});
