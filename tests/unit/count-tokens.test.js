import { describe, expect, it } from "vitest";

import { POST } from "../../src/app/api/v1/messages/count_tokens/route.js";

async function countTokens(body) {
  const response = await POST(new Request("https://9router.local/v1/messages/count_tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));

  expect(response.status).toBe(200);
  return response.json();
}

describe("Anthropic count_tokens estimator", () => {
  it("includes a small framing allowance for plain text", async () => {
    const result = await countTokens({
      messages: [
        {
          role: "user",
          content: "hello world",
        },
      ],
    });

    expect(result.input_tokens).toBeGreaterThanOrEqual(3);
    expect(result.input_tokens).toBeLessThan(20);
  });

  it("does not apply the ASCII four-character ratio to Thai text", async () => {
    const result = await countTokens({ messages: [{ role: "user", content: "ก".repeat(1000) }] });
    expect(result.input_tokens).toBeGreaterThanOrEqual(1000);
  });

  it("labels counts as estimates and excludes encoded media from text counts", async () => {
    const response = await POST(new Request("https://9router.local/v1/messages/count_tokens", {
      method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(100000) } },
      ] }] }),
    }));
    expect(response.headers.get("X-888-Token-Count-Method")).toBe("estimate");
    expect((await response.json()).input_tokens).toBeLessThan(100);
  });

  it("counts tool and thinking content blocks that carry context", async () => {
    const result = await countTokens({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_01",
              name: "Read",
              input: { file_path: "/tmp/example.txt" },
            },
            {
              type: "thinking",
              thinking: "Need to inspect the file before answering.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01",
              content: "line1 line2 line3 some file content here",
            },
          ],
        },
      ],
    });

    expect(result.input_tokens).toBeGreaterThan(0);
  });

  it("counts system prompts and tool definitions", async () => {
    const result = await countTokens({
      system: "You are a coding assistant.",
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: {
              file_path: { type: "string" },
            },
          },
        },
      ],
      messages: [],
    });

    expect(result.input_tokens).toBeGreaterThan(0);
  });
});
