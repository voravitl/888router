import { describe, it, expect } from "vitest";
import { resolveTransport } from "../../open-sse/services/provider.js";
import { getModelSupportedFormats } from "../../open-sse/config/providerModels.js";

// Regression: paid muse-spark on opencode-go declares ["openai-responses"] only.
// With a claude-format client the old chatCore logic resolved useTransport=null
// and fell back to the provider default ("openai"), producing a chat-shaped
// body sent to /zen/go/v1/responses → upstream 400 "unknown parameter
// `messages`". The fix picks the transport matching the model's FIRST declared
// format when sourceFormat is unsupported.
function pickTransport(provider, sourceFormat, alias, model) {
  const supported = getModelSupportedFormats(alias, model);
  return (!supported || supported.includes(sourceFormat))
    ? resolveTransport(provider, sourceFormat)
    : resolveTransport(provider, supported[0]);
}

describe("chatCore per-model transport pick (responses-only models)", () => {
  it("claude client + paid muse-spark → openai-responses transport", () => {
    const t = pickTransport("opencode-go", "claude", "opencode-go", "muse-spark-1.3-contributor");
    expect(t?.format).toBe("openai-responses");
    expect(t?.baseUrl).toBe("https://opencode.ai/zen/go/v1/responses");
  });

  it("openai client + chat-only model keeps chat/completions transport", () => {
    const t = pickTransport("opencode-go", "openai", "opencode-go", "longcat-2.5-preview-free");
    expect(t?.format).toBe("openai");
    expect(t?.baseUrl).toBe("https://opencode.ai/zen/go/v1/chat/completions");
  });

  it("claude client + chat-only model resolves the openai transport (chat/completions)", () => {
    const t = pickTransport("opencode-go", "claude", "opencode-go", "glm-5.2");
    expect(t?.format).toBe("openai");
    expect(t?.baseUrl).toBe("https://opencode.ai/zen/go/v1/chat/completions");
  });
});
