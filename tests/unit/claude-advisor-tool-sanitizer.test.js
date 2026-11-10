import { describe, it, expect } from "vitest";
import {
  sanitizeClaudeTools,
  normalizeClaudePassthrough,
  stripSyntheticClaudeSignatures,
} from "../../open-sse/translator/formats/claude.js";

describe("sanitizeClaudeTools: strip advisor_tool to prevent Anthropic 400 rejection", () => {
  it("strips advisor_tool while keeping standard tools intact", () => {
    const body = {
      model: "claude-3-5-sonnet-20241022",
      tools: [
        {
          name: "Read",
          description: "Read file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
        {
          type: "advisor_tool",
          name: "advisor",
          model: "9-fable",
        },
        {
          name: "Edit",
          description: "Edit file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    };

    sanitizeClaudeTools(body);

    expect(body.tools).toHaveLength(2);
    expect(body.tools.map((t) => t.name)).toEqual(["Read", "Edit"]);
    expect(body.tools.some((t) => t.type === "advisor_tool")).toBe(false);
  });

  it("deletes tools and tool_choice completely when advisor_tool was the only tool", () => {
    const body = {
      model: "claude-3-5-sonnet-20241022",
      tool_choice: { type: "auto" },
      tools: [
        {
          type: "advisor_tool",
          name: "advisor",
          model: "9-fable",
        },
      ],
    };

    sanitizeClaudeTools(body);

    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it("normalizeClaudePassthrough automatically strips advisor_tool", () => {
    const body = {
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "advisor_tool",
          name: "advisor",
          model: "fable",
        },
      ],
    };

    normalizeClaudePassthrough(body, body.model);

    expect(body.tools).toBeUndefined();
  });

  it("stripSyntheticClaudeSignatures drops advisor_tool_result content blocks", () => {
    const body = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "I need to consult the advisor" },
            { type: "advisor_tool_result", content: { type: "advisor_result", text: "Approved" } },
          ],
        },
      ],
    };

    stripSyntheticClaudeSignatures(body);

    expect(body.messages[0].content).toEqual([
      { type: "text", text: "I need to consult the advisor" },
    ]);
  });
});
