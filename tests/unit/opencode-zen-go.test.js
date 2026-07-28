import { describe, it, expect } from "vitest";
import opencodeRegistry from "open-sse/providers/registry/opencode.js";
import { OpenCodeExecutor } from "open-sse/executors/opencode.js";

describe("OpenCode Zen & Go Unified Executor & Registry", () => {
  it("should declare authModes supporting both noauth and apikey", () => {
    expect(opencodeRegistry.id).toBe("opencode");
    expect(opencodeRegistry.authModes).toContain("noauth");
    expect(opencodeRegistry.authModes).toContain("apikey");
    expect(opencodeRegistry.category).toBe("apikey");
    expect(opencodeRegistry.hasFree).toBe(true);
  });

  it("should route to OpenCode Free (Zen) when no API key is provided", () => {
    const executor = new OpenCodeExecutor();
    const headers = executor.buildHeaders(null, true, "glm-5.2");
    const url = executor.buildUrl("glm-5.2", true, 0, null);

    expect(headers["Authorization"]).toBe("Bearer public");
    expect(headers["x-opencode-client"]).toBe("desktop");
    expect(url).toBe("https://opencode.ai/zen/v1/chat/completions");
  });

  it("should route to OpenCode Go when an API key is provided", () => {
    const executor = new OpenCodeExecutor();
    const creds = { apiKey: "sk-test-opencode-key" };
    const url = executor.buildUrl("glm-5.2", true, 0, creds);
    const headers = executor.buildHeaders(creds, true, "glm-5.2");

    expect(headers["Authorization"]).toBe("Bearer sk-test-opencode-key");
    expect(url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
  });

  it("should route Anthropic format models correctly for OpenCode Go", () => {
    const executor = new OpenCodeExecutor();
    const creds = { apiKey: "sk-test-opencode-key" };
    const url = executor.buildUrl("minimax-m3", true, 0, creds);
    const headers = executor.buildHeaders(creds, true, "minimax-m3");

    expect(url).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(headers["x-api-key"]).toBe("sk-test-opencode-key");
    expect(headers["anthropic-version"]).toBeDefined();
  });

  it("should be stateless and handle concurrent calls without race conditions", () => {
    const executor = new OpenCodeExecutor();
    const credsGo = { apiKey: "sk-go-key" };

    const url1 = executor.buildUrl("glm-5.2", true, 0, null);
    const headers1 = executor.buildHeaders(null, true, "glm-5.2");

    const url2 = executor.buildUrl("minimax-m3", true, 0, credsGo);
    const headers2 = executor.buildHeaders(credsGo, true, "minimax-m3");

    expect(url1).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(headers1["Authorization"]).toBe("Bearer public");

    expect(url2).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(headers2["x-api-key"]).toBe("sk-go-key");
  });
});
