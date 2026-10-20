// Locks edge cases flagged in docs 11 §1/§4 that were only covered indirectly.
import { describe, it, expect } from "vitest";
import { normalizeClaudePassthrough, normalizeClaudeThinkingShape } from "../../open-sse/translator/formats/claude.js";
import { parseDataUri, encodeDataUri } from "../../open-sse/translator/concerns/image.js";

describe("normalizeClaudePassthrough — haiku adaptive thinking (docs 11 §1)", () => {
  it("downgrades adaptive thinking to enabled+budget for haiku models", () => {
    const out = normalizeClaudePassthrough({ thinking: { type: "adaptive" } }, "claude-haiku-4-5");
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
  });

  it("keeps adaptive thinking for sonnet/opus", () => {
    const out = normalizeClaudePassthrough({ thinking: { type: "adaptive" } }, "claude-sonnet-4-6");
    expect(out.thinking).toEqual({ type: "adaptive" });
  });

  it("keeps adaptive thinking (and effort) for Haiku 5.5 — it rejects enabled", () => {
    const out = normalizeClaudePassthrough({
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    }, "claude-haiku-5-5");
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("converts an enabled+budget thinking shape to adaptive for Haiku 5.5", () => {
    const out = normalizeClaudeThinkingShape({
      thinking: { type: "enabled", budget_tokens: 16000 },
    }, "claude-haiku-5-5");
    expect(out.thinking).toEqual({ type: "adaptive" });
  });

  it("still downgrades an adaptive thinking shape to enabled+budget for Haiku 4.5", () => {
    const out = normalizeClaudeThinkingShape({
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    }, "claude-haiku-4-5");
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
    expect(out.output_config).toBeUndefined();
  });

  it("leaves non-Haiku budget models untouched (no widened downgrade)", () => {
    const out = normalizeClaudeThinkingShape({
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    }, "claude-opus-4-5");
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("does not read a date suffix as Haiku generation (claude-3-5-haiku-20241022)", () => {
    const out = normalizeClaudeThinkingShape({
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    }, "claude-3-5-haiku-20241022");
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
    expect(out.output_config).toBeUndefined();
  });

  it("keeps enabled thinking on Claude 4.6, which still accepts it", () => {
    const out = normalizeClaudeThinkingShape({
      thinking: { type: "enabled", budget_tokens: 8000 },
    }, "claude-sonnet-4-6");
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
  });

  it("converts enabled thinking to adaptive on Claude 4.7+, where enabled is rejected", () => {
    const out = normalizeClaudeThinkingShape({
      thinking: { type: "enabled", budget_tokens: 8000 },
    }, "claude-opus-4-7");
    expect(out.thinking).toEqual({ type: "adaptive" });
  });

  it("folds mid-conversation system messages into neighbouring turn", () => {
    const out = normalizeClaudePassthrough({
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "be brief" },
      ],
    });
    expect(out.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "text", text: "be brief" },
        ],
      },
    ]);
    expect(out.messages.every((m) => m.role !== "system")).toBe(true);
  });
});

describe("parseDataUri / encodeDataUri (docs 11 §4)", () => {
  it("parses a base64 data uri", () => {
    expect(parseDataUri("data:image/png;base64,AAAB")).toEqual({ mimeType: "image/png", base64: "AAAB" });
  });

  it("tolerates newlines inside base64 payload", () => {
    expect(parseDataUri("data:image/jpeg;base64,AA\nBB")?.base64).toBe("AA\nBB");
  });

  it("returns null for http urls and non-strings", () => {
    expect(parseDataUri("https://x/y.png")).toBeNull();
    expect(parseDataUri(null)).toBeNull();
  });

  it("encode/parse roundtrip", () => {
    const uri = encodeDataUri("image/webp", "ZZZ");
    expect(parseDataUri(uri)).toEqual({ mimeType: "image/webp", base64: "ZZZ" });
  });
});
