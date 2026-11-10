import { describe, it, expect } from "vitest";
import { isValidClaudeSignature } from "../../open-sse/utils/claudeSignature.js";
import { DEFAULT_THINKING_CLAUDE_SIGNATURE, DEFAULT_THINKING_GEMINI_SIGNATURE } from "../../open-sse/config/defaultThinkingSignature.js";
import { normalizeClaudePassthrough, prepareClaudeRequest, stripSyntheticClaudeSignatures } from "../../open-sse/translator/formats/claude.js";

describe("Claude thinking signature validation", () => {
  it("rejects synthetic DEFAULT_THINKING_CLAUDE_SIGNATURE", () => {
    expect(isValidClaudeSignature(DEFAULT_THINKING_CLAUDE_SIGNATURE)).toBe(false);
  });

  it("rejects synthetic DEFAULT_THINKING_GEMINI_SIGNATURE", () => {
    expect(isValidClaudeSignature(DEFAULT_THINKING_GEMINI_SIGNATURE)).toBe(false);
  });

  it("accepts authentic non-synthetic Claude signature", () => {
    // Generate a valid base64 signature starting with E and marker 0x12
    const buf = Buffer.alloc(32);
    buf[0] = 0x12; // CLAUDE_SIGNATURE_MARKER
    const validSig = buf.toString("base64");
    expect(validSig[0]).toBe("E");
    expect(isValidClaudeSignature(validSig)).toBe(true);
  });
});

describe("normalizeClaudePassthrough — drops synthetic signatures from combo turns", () => {
  it("drops thinking block carrying DEFAULT_THINKING_CLAUDE_SIGNATURE", () => {
    const body = {
      model: "claude-sonnet-5-5",
      thinking: { type: "adaptive" },
      messages: [
        { role: "user", content: "previous turn" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "deep thoughts from deepseek", signature: DEFAULT_THINKING_CLAUDE_SIGNATURE },
            { type: "text", text: "result from deepseek" },
          ],
        },
        { role: "user", content: "current turn" },
      ],
    };

    const out = normalizeClaudePassthrough(body, "claude-sonnet-5-5");
    expect(out.messages[1].content).toEqual([
      { type: "text", text: "result from deepseek" },
    ]);
  });

  it("does not insert DEFAULT_THINKING_CLAUDE_SIGNATURE when assistant has tool_use", () => {
    const body = {
      model: "claude-sonnet-4-5",
      thinking: { type: "enabled", budget_tokens: 2000 },
      messages: [
        { role: "user", content: "run tool" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "dropped thinking", signature: DEFAULT_THINKING_CLAUDE_SIGNATURE },
            { type: "tool_use", id: "toolu_01", name: "bash", input: { command: "ls" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "ok" }],
        },
      ],
    };

    const out = normalizeClaudePassthrough(body, "claude-sonnet-4-5");
    const assistantBlocks = out.messages[1].content;
    const thinkingBlocks = assistantBlocks.filter(b => b.type === "thinking" || b.type === "redacted_thinking");
    expect(thinkingBlocks).toHaveLength(0);
    expect(assistantBlocks[0].type).toBe("tool_use");
  });
});

describe("prepareClaudeRequest — drops synthetic signatures for native claude provider", () => {
  it("drops synthetic thinking signature when provider is claude", () => {
    const body = {
      model: "claude-sonnet-5-5",
      thinking: { type: "adaptive" },
      messages: [
        { role: "user", content: "previous turn" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "deep thoughts", signature: DEFAULT_THINKING_CLAUDE_SIGNATURE },
            { type: "text", text: "text answer" },
          ],
        },
        { role: "user", content: "current turn" },
      ],
    };

    const out = prepareClaudeRequest(body, "claude");
    expect(out.messages[1].content).toEqual([
      { type: "text", text: "text answer", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("does not insert synthetic thinking signature when provider is claude and message has tool_use", () => {
    const body = {
      model: "claude-sonnet-4-5",
      thinking: { type: "enabled", budget_tokens: 2000 },
      messages: [
        { role: "user", content: "run tool" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "dropped", signature: DEFAULT_THINKING_CLAUDE_SIGNATURE },
            { type: "tool_use", id: "toolu_01", name: "bash", input: { command: "ls" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "ok" }],
        },
      ],
    };

    const out = prepareClaudeRequest(body, "claude");
    const assistantBlocks = out.messages[1].content;
    const thinkingBlocks = assistantBlocks.filter(b => b.type === "thinking" || b.type === "redacted_thinking");
    expect(thinkingBlocks).toHaveLength(0);
  });
});

describe("stripSyntheticClaudeSignatures — used under native fidelity", () => {
  it("strips synthetic thinking signatures but preserves authentic/opaque signatures", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "fake from deepseek", signature: DEFAULT_THINKING_CLAUDE_SIGNATURE },
            { type: "text", text: "keep this text" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "authentic reasoning", signature: "real-or-opaque-claude-sig" },
            { type: "text", text: "keep this text too" },
          ],
        },
      ],
    };

    const out = stripSyntheticClaudeSignatures(body);
    expect(out.messages[0].content).toEqual([
      { type: "text", text: "keep this text" },
    ]);
    expect(out.messages[1].content).toEqual([
      { type: "thinking", thinking: "authentic reasoning", signature: "real-or-opaque-claude-sig" },
      { type: "text", text: "keep this text too" },
    ]);
  });

  it("strips foreign server_tool_use and paired result", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "call_abc123", name: "search", input: {} },
            { type: "text", text: "searching" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_abc123", content: "data" },
            { type: "text", text: "user prompt" },
          ],
        },
      ],
    };

    const out = stripSyntheticClaudeSignatures(body);
    expect(out.messages[0].content).toEqual([{ type: "text", text: "searching" }]);
    expect(out.messages[1].content).toEqual([{ type: "text", text: "user prompt" }]);
  });
});
