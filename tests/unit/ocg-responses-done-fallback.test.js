import { describe, it, expect } from "vitest";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";
import { extractResponsesMessageText } from "../../open-sse/translator/concerns/message.js";

// Compact Responses streams carry full text in terminal events with NO
// preceding per-token deltas (seen on opencode-go muse-spark: 1-chunk empty
// client streams). The translator ignored .done events → empty output.
// Fallback emits the terminal text only when no delta was seen (no doubles).
function runEvents(events) {
  const state = {};
  const out = [];
  for (const e of events) {
    const r = openaiResponsesToOpenAIResponse(e, state);
    if (Array.isArray(r)) out.push(...r.filter(Boolean));
    else if (r) out.push(r);
  }
  out.push(openaiResponsesToOpenAIResponse(null, state));
  return out.filter(Boolean);
}

const contentOf = (chunks) =>
  chunks
    .map((c) => c?.choices?.[0]?.delta?.content || "")
    .join("");

describe("compact Responses streams (done-events without deltas)", () => {
  it("emits output_text.done full text when no delta arrived", () => {
    const chunks = runEvents([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "4" },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
    ]);
    expect(contentOf(chunks)).toBe("4");
  });

  it("emits output_item.done message text when no delta arrived", () => {
    const chunks = runEvents([
      { type: "response.created", response: { id: "resp_2" } },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
    ]);
    expect(contentOf(chunks)).toBe("hello");
  });

  it("does NOT double-emit when deltas already arrived", () => {
    const chunks = runEvents([
      { type: "response.created", response: { id: "resp_3" } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "4" },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "4" },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "4" }] },
      },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
    ]);
    expect(contentOf(chunks)).toBe("4");
  });

  it("extractResponsesMessageText covers item/part/string shapes", () => {
    expect(extractResponsesMessageText({ type: "message", content: [{ type: "output_text", text: "x" }] })).toBe("x");
    expect(extractResponsesMessageText([{ type: "text", text: "y" }])).toBe("y");
    expect(extractResponsesMessageText("z")).toBe("z");
    expect(extractResponsesMessageText({ type: "message", content: [] })).toBe("");
    expect(extractResponsesMessageText(null)).toBe("");
  });
});
