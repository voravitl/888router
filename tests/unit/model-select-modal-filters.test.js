import { describe, it, expect } from "vitest";
import { formatContextWindow, CONTEXT_FILTER_OPTIONS } from "@/shared/utils/contextWindow";
import { resolveKnownContextWindow } from "open-sse/providers/capabilities.js";

describe("ModelSelectModal Filter & Context Helpers", () => {
  describe("formatContextWindow", () => {
    it("formats 1,000,000 to 1M", () => {
      expect(formatContextWindow(1000000)).toBe("1M");
    });

    it("formats power-of-two 1,048,576 to 1M (not 1.0M)", () => {
      expect(formatContextWindow(1048576)).toBe("1M");
    });

    it("formats 2,000,000 and 2,097,152 to 2M", () => {
      expect(formatContextWindow(2000000)).toBe("2M");
      expect(formatContextWindow(2097152)).toBe("2M");
    });

    it("formats 128,000 and 131,072 to 128K", () => {
      expect(formatContextWindow(128000)).toBe("128K");
      expect(formatContextWindow(131072)).toBe("128K");
    });

    it("formats 200,000 to 200K", () => {
      expect(formatContextWindow(200000)).toBe("200K");
    });

    it("formats 262,144 to 256K", () => {
      expect(formatContextWindow(262144)).toBe("256K");
    });

    it("formats 32,768 to 32K (not 33K)", () => {
      expect(formatContextWindow(32768)).toBe("32K");
    });

    it("formats 65,536 to 64K (not 66K)", () => {
      expect(formatContextWindow(65536)).toBe("64K");
    });

    it("formats 8,192 to 8K", () => {
      expect(formatContextWindow(8192)).toBe("8K");
    });

    it("parses valid numeric strings cleanly", () => {
      expect(formatContextWindow("1000000")).toBe("1M");
      expect(formatContextWindow("128000")).toBe("128K");
    });

    it("returns null for non-positive or invalid numbers", () => {
      expect(formatContextWindow(0)).toBe(null);
      expect(formatContextWindow(-100)).toBe(null);
      expect(formatContextWindow(null)).toBe(null);
      expect(formatContextWindow(undefined)).toBe(null);
      expect(formatContextWindow("invalid")).toBe(null);
      expect(formatContextWindow(NaN)).toBe(null);
    });
  });

  describe("resolveKnownContextWindow vs DEFAULT floor", () => {
    it("returns known contextWindow for cataloged models", () => {
      expect(resolveKnownContextWindow("openai", "gpt-4o")).toBe(128000);
      expect(resolveKnownContextWindow("google", "gemini-2.5-flash")).toBe(1048576);
    });

    it("returns undefined for genuinely unknown models without default 200000 floor", () => {
      expect(resolveKnownContextWindow("custom-provider", "unknown-xyz-random-12345")).toBe(undefined);
    });
  });

  describe("CONTEXT_FILTER_OPTIONS", () => {
    it("contains All, 128K, 200K, and 1M thresholds", () => {
      expect(CONTEXT_FILTER_OPTIONS).toEqual([
        { value: 0, label: "All Context" },
        { value: 128000, label: "≥ 128K" },
        { value: 200000, label: "≥ 200K" },
        { value: 1000000, label: "≥ 1M" },
      ]);
    });
  });

  describe("Filtering Logic Simulation", () => {
    const mockModels = [
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", value: "antigravity/gemini-2.5-flash", provider: "antigravity", caps: { vision: true, reasoning: false, contextWindow: 1048576 } },
      { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet", value: "antigravity/claude-3-7-sonnet", provider: "antigravity", caps: { vision: true, reasoning: true, contextWindow: 200000 } },
      { id: "deepseek-r1", name: "DeepSeek R1", value: "openrouter/deepseek-r1", provider: "openrouter", caps: { vision: false, reasoning: true, contextWindow: 128000 } },
      { id: "minimax-m3", name: "MiniMax M3", value: "openrouter/minimax-m3", provider: "openrouter", caps: { vision: false, reasoning: false, contextWindow: 1000000 } },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", value: "openai/gpt-4o-mini", provider: "openai", caps: { vision: true, reasoning: false, contextWindow: 128000 } },
      { id: "unknown-custom-model", name: "Unknown Custom", value: "custom/unknown-model", provider: "custom", caps: { vision: false, reasoning: false, contextWindow: undefined } },
    ];

    it("filters by provider", () => {
      const filtered = mockModels.filter((m) => m.provider === "openrouter");
      expect(filtered.map((m) => m.id)).toEqual(["deepseek-r1", "minimax-m3"]);
    });

    it("filters by context window >= 1M and excludes unknown models", () => {
      const filtered = mockModels.filter((m) => (m.caps.contextWindow || 0) >= 1000000);
      expect(filtered.map((m) => m.id)).toEqual(["gemini-2.5-flash", "minimax-m3"]);
    });

    it("filters by context window >= 200K and excludes unknown models", () => {
      const filtered = mockModels.filter((m) => (m.caps.contextWindow || 0) >= 200000);
      expect(filtered.map((m) => m.id)).toEqual(["gemini-2.5-flash", "claude-3-7-sonnet", "minimax-m3"]);
    });

    it("filters by vision capability", () => {
      const filtered = mockModels.filter((m) => m.caps.vision);
      expect(filtered.map((m) => m.id)).toEqual(["gemini-2.5-flash", "claude-3-7-sonnet", "gpt-4o-mini"]);
    });

    it("filters by reasoning capability", () => {
      const filtered = mockModels.filter((m) => m.caps.reasoning);
      expect(filtered.map((m) => m.id)).toEqual(["claude-3-7-sonnet", "deepseek-r1"]);
    });

    it("combines provider + vision + context filters", () => {
      const filtered = mockModels.filter(
        (m) => m.provider === "antigravity" && m.caps.vision && (m.caps.contextWindow || 0) >= 1000000
      );
      expect(filtered.map((m) => m.id)).toEqual(["gemini-2.5-flash"]);
    });
  });
});
