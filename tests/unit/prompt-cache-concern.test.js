import { describe, it, expect } from "vitest";
import { injectPromptCaching } from "../../open-sse/translator/concerns/promptCache.js";

describe("Upstream Prompt Caching Concern (Grok Review Hardened)", () => {
  it("injects Anthropic cache_control into system prompt and tools for Claude format", () => {
    const body = {
      system: "You are a helpful coding assistant",
      tools: [{ name: "read_file", description: "Read a file" }],
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "explain code" },
        { role: "assistant", content: "sure" }
      ]
    };

    const injected = injectPromptCaching(body, "claude");
    expect(injected).toBe(true);
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(body.tools[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("never exceeds 4 breakpoints and preserves existing client cache_control", () => {
    const body = {
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      tools: [
        { name: "t1", cache_control: { type: "ephemeral" } },
        { name: "t2", cache_control: { type: "ephemeral" } },
        { name: "t3", cache_control: { type: "ephemeral" } }
      ],
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" }
      ]
    };

    const injected = injectPromptCaching(body, "claude");
    expect(injected).toBe(false); // Already at 4 breakpoints
  });

  it("never puts cache_control on thinking blocks", () => {
    const body = {
      messages: [
        { role: "user", content: "think" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "deep thoughts" },
            { type: "text", text: "result text" }
          ]
        },
        { role: "user", content: [{ type: "thinking", thinking: "user thinking" }] }, // invalid type -> skipped
        { role: "assistant", content: "done" }
      ]
    };

    const injected = injectPromptCaching(body, "claude");
    expect(injected).toBe(true);
    // Index 2 had only thinking block, so it was skipped and index 1 was selected:
    const assistantMsg = body.messages[1];
    expect(assistantMsg.content[0].cache_control).toBeUndefined(); // thinking block skipped
    expect(assistantMsg.content[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("normalizes system/developer prompt position for OpenAI and Codex (body.input)", () => {
    const body = {
      input: [
        { role: "user", content: "first user turn" },
        { role: "developer", content: "system instructions" }
      ]
    };

    const injected = injectPromptCaching(body, "openai-responses");
    expect(injected).toBe(true);
    expect(body.input[0].role).toBe("developer");
    expect(body.input[1].role).toBe("user");
  });

  it("returns false for unsupported format or missing body", () => {
    expect(injectPromptCaching(null, "claude")).toBe(false);
    expect(injectPromptCaching({}, "unknown")).toBe(false);
  });
});
