import { describe, it, expect, beforeEach } from "vitest";
import {
  hasImageContent,
  hashImage,
  bridgeVisionToText,
  clearBridgeCache,
} from "../../open-sse/services/modalityBridge.js";

describe("Modality Bridge", () => {
  beforeEach(() => {
    clearBridgeCache();
  });

  it("detects image blocks in OpenAI and Claude message schemas", () => {
    const openaiBody = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo..." } },
          ],
        },
      ],
    };
    const claudeBody = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze this image" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "xyz..." } },
          ],
        },
      ],
    };
    const textOnlyBody = {
      messages: [{ role: "user", content: "Hello there" }],
    };

    expect(hasImageContent(openaiBody)).toBe(true);
    expect(hasImageContent(claudeBody)).toBe(true);
    expect(hasImageContent(textOnlyBody)).toBe(false);
  });

  it("passes image through untouched if target model supports vision natively", async () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this chart" },
            { type: "image_url", image_url: { url: "https://example.com/chart.png" } },
          ],
        },
      ],
    };

    // gpt-4o natively supports vision
    const { transformedBody, bridgedCount } = await bridgeVisionToText(body, {
      targetModel: "openai/gpt-4o",
    });

    expect(bridgedCount).toBe(0);
    expect(transformedBody.messages[0].content[1].type).toBe("image_url");
  });

  it("replaces image block with text description when target model is text-only", async () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Explain this code screenshot" },
            { type: "image_url", image_url: { url: "data:image/png;base64,screenshot..." } },
          ],
        },
      ],
    };

    let describeCalled = 0;
    const describeImage = async () => {
      describeCalled++;
      return "A Python function definition for quicksort algorithm";
    };

    // deepseek-chat is text-only
    const { transformedBody, bridgedCount } = await bridgeVisionToText(body, {
      targetModel: "deepseek/deepseek-chat",
      describeImage,
    });

    expect(bridgedCount).toBe(1);
    expect(describeCalled).toBe(1);
    expect(transformedBody.messages[0].content[1].type).toBe("text");
    expect(transformedBody.messages[0].content[1].text).toContain(
      "A Python function definition for quicksort algorithm"
    );

    // Second call with same image hits in-memory cache (describeImage not called again)
    const secondRun = await bridgeVisionToText(body, {
      targetModel: "deepseek/deepseek-chat",
      describeImage,
    });
    expect(secondRun.bridgedCount).toBe(1);
    expect(describeCalled).toBe(1); // cache hit!
  });

  it("handles vision describe failure gracefully with fallback text", async () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,badimage..." } },
          ],
        },
      ],
    };

    const describeImage = async () => {
      throw new Error("Upstream vision provider timeout");
    };

    const { transformedBody, bridgedCount } = await bridgeVisionToText(body, {
      targetModel: "deepseek/deepseek-chat",
      describeImage,
    });

    expect(bridgedCount).toBe(1);
    expect(transformedBody.messages[0].content[0].type).toBe("text");
    expect(transformedBody.messages[0].content[0].text).toContain(
      "Upstream vision provider timeout"
    );
  });
});
