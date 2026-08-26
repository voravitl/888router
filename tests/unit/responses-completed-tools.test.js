import { describe, it, expect } from "vitest";
import { stripResponsesLifecycleEcho } from "../../open-sse/utils/responsesStreamHelpers.js";

describe("stripResponsesLifecycleEcho", () => {
  it("strips instructions from response.created, response.in_progress, and response.completed", () => {
    const created = {
      type: "response.created",
      response: {
        id: "resp_1",
        instructions: "System instruction payload that is large",
        tools: [{ type: "function", name: "test_tool" }]
      }
    };
    const inProgress = {
      type: "response.in_progress",
      response: {
        id: "resp_1",
        instructions: "System instruction payload that is large",
        tools: [{ type: "function", name: "test_tool" }]
      }
    };
    const completed = {
      type: "response.completed",
      response: {
        id: "resp_1",
        instructions: "System instruction payload that is large",
        tools: [{ type: "function", name: "test_tool" }]
      }
    };

    expect(stripResponsesLifecycleEcho(created)).toBe(true);
    expect(created.response.instructions).toBeUndefined();
    expect(created.response.tools).toBeUndefined();

    expect(stripResponsesLifecycleEcho(inProgress)).toBe(true);
    expect(inProgress.response.instructions).toBeUndefined();
    expect(inProgress.response.tools).toBeUndefined();

    expect(stripResponsesLifecycleEcho(completed)).toBe(true);
    expect(completed.response.instructions).toBeUndefined();
    // Invariant: tools MUST be preserved in response.completed for Codex CLI tool restoration
    expect(completed.response.tools).toEqual([{ type: "function", name: "test_tool" }]);
  });

  it("returns false for non-lifecycle events or malformed payloads", () => {
    expect(stripResponsesLifecycleEcho(null)).toBe(false);
    expect(stripResponsesLifecycleEcho(undefined)).toBe(false);
    expect(stripResponsesLifecycleEcho("string")).toBe(false);
    expect(stripResponsesLifecycleEcho({ type: "response.output_item.added" })).toBe(false);
    expect(stripResponsesLifecycleEcho({ type: "response.created", response: {} })).toBe(false);
  });
});
