import { describe, it, expect } from "vitest";
import { compressMessages, applyHardCap } from "../../open-sse/rtk/index.js";
import { HARD_CAP_BYTES } from "../../open-sse/rtk/constants.js";

describe("RTK v2 Hard Caps & Gemini Format Compression (Hardened)", () => {
  it("strictly enforces hard cap length invariant without increasing size", () => {
    const hugeText = Array.from({ length: 1000 }, (_, i) => `line ${i}: ` + "x".repeat(50)).join("\n");
    expect(hugeText.length).toBeGreaterThan(HARD_CAP_BYTES);

    const capped = applyHardCap(hugeText, 5000);
    expect(capped.length).toBeLessThanOrEqual(5000);
    expect(capped.length).toBeLessThan(hugeText.length);
    expect(capped).toContain("[... truncated");
    expect(capped).toContain("by 888router RTK Hard Cap");
  });

  it("handles short cap limits safely without growing text", () => {
    const text = "1234567890".repeat(10); // 100 chars
    const capped = applyHardCap(text, 20);
    expect(capped.length).toBeLessThanOrEqual(20);
  });

  it("compresses Gemini contents function/tool responses while preserving object structure", () => {
    const hugeToolOutput = Array.from({ length: 500 }, (_, i) => `log output line ${i}: ` + "a".repeat(100)).join("\n");
    const body = {
      contents: [
        {
          role: "function",
          parts: [
            {
              functionResponse: {
                name: "execute_command",
                response: { output: hugeToolOutput }
              }
            }
          ]
        }
      ]
    };

    const stats = compressMessages(body, true);
    expect(stats).not.toBeNull();
    expect(stats.hits.length).toBeGreaterThan(0);
    expect(typeof body.contents[0].parts[0].functionResponse.response).toBe("object"); // Object preserved!
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore);
  });

  it("still applies hard cap when input exceeds RAW_CAP (>10MB)", () => {
    const massiveText = "a".repeat(11 * 1024 * 1024); // 11 MB
    const body = {
      messages: [
        { role: "user", content: "hello" },
        { role: "tool", content: massiveText }
      ]
    };

    const stats = compressMessages(body, true);
    expect(stats).not.toBeNull();
    expect(body.messages[1].content.length).toBeLessThanOrEqual(HARD_CAP_BYTES);
  });

  it("handles undefined, null, and non-string Gemini response gracefully without crash", () => {
    const body = {
      contents: [
        {
          role: "function",
          parts: [
            { functionResponse: { name: "test", response: null } },
            { functionResponse: undefined },
            { text: null }
          ]
        }
      ]
    };

    const stats = compressMessages(body, true);
    expect(stats).not.toBeNull();
  });

  it("strictly protects invariant out.length > 0 when capBytes is non-positive or zero (#450)", () => {
    const text = "hello world this is a test string";
    // Non-positive capBytes safely falls back to HARD_CAP_BYTES rather than returning empty
    const cappedZero = applyHardCap(text, 0);
    expect(cappedZero.length).toBeGreaterThan(0);
    expect(cappedZero).toBe(text); // text.length <= HARD_CAP_BYTES

    const hugeText = "x".repeat(50000);
    const cappedHuge = applyHardCap(hugeText, 0);
    expect(cappedHuge.length).toBeLessThanOrEqual(HARD_CAP_BYTES);
    expect(cappedHuge.length).toBeGreaterThan(0);

    // Positive cap of 1 byte satisfies out.length <= capBytes && out.length > 0
    const cappedOne = applyHardCap(text, 1);
    expect(cappedOne.length).toBe(1);
    expect(cappedOne).toBe("h");
  });
});
