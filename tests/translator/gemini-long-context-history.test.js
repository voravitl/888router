import { describe, expect, it } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { estimateRequestTokens } from "../../open-sse/services/requestContext.js";

const translate = (body) => translateRequest(FORMATS.GEMINI, FORMATS.OPENAI, "gpt-4o", body, false, null, "openai");

describe("Gemini large mixed history through the real translator", () => {
  it("retains every result, 500K text markers, and image after a functionResponse", () => {
    const document = `START_MARKER\n${"reference ".repeat(100000)}MIDDLE_MARKER\n${"reference ".repeat(100000)}END_MARKER`;
    const body = { contents: [
      { role: "model", parts: [{ functionCall: { id: "first", name: "lookup", args: { id: 1 } } }, { functionCall: { id: "second", name: "check", args: { id: 2 } } }] },
      { role: "user", parts: [
        { functionResponse: { id: "first", name: "lookup", response: { result: "found", extra: "keep metadata" } } },
        { functionResponse: { id: "second", name: "check", response: { result: false } } },
        { text: document }, { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }, { text: "FINAL_INSTRUCTION" },
      ] },
    ], tools: [{ functionDeclarations: [{ name: "lookup" }, { name: "check" }] }] };
    expect(estimateRequestTokens(body)).toBeGreaterThanOrEqual(500000);
    const output = translate(body);
    expect(output.messages.map((message) => message.role)).toEqual(["assistant", "tool", "tool", "user"]);
    expect(output.messages[0].tool_calls.map((call) => call.id)).toEqual(["first", "second"]);
    expect(JSON.parse(output.messages[1].content)).toEqual({ result: "found", extra: "keep metadata" });
    expect(JSON.parse(output.messages[2].content)).toEqual({ result: false });
    expect(output.messages[3].content).toEqual([
      { type: "text", text: document }, { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }, { type: "text", text: "FINAL_INSTRUCTION" },
    ]);
    expect(output.tools.map((tool) => tool.function.name)).toEqual(["lookup", "check"]);
  });

  it("keeps interleaved text and results in source order", () => {
    const output = translate({ contents: [{ role: "user", parts: [
      { text: "before" }, { functionResponse: { name: "one", response: { value: 0 } } },
      { text: "between" }, { functionResponse: { name: "two", response: { value: 2 } } }, { text: "after" },
    ] }] });
    expect(output.messages.map((message) => message.role)).toEqual(["user", "tool", "user", "tool", "user"]);
    expect(output.messages.map((message) => message.content)).toEqual(["before", '{"value":0}', "between", '{"value":2}', "after"]);
  });

  it("pairs parallel same-name calls without explicit ids with distinct ordered results", () => {
    const output = translate({ contents: [
      { role: "model", parts: [{ functionCall: { name: "lookup", args: { id: 1 } } }, { functionCall: { name: "lookup", args: { id: 2 } } }] },
      { role: "user", parts: [{ functionResponse: { name: "lookup", response: { value: 1 } } }, { functionResponse: { name: "lookup", response: { value: 2 } } }, { text: "continue" }] },
    ] });
    const ids = output.messages[0].tool_calls.map((call) => call.id);
    expect(new Set(ids).size).toBe(2);
    expect(output.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(ids);
    expect(output.messages.at(-1).content).toBe("continue");
  });

  it("preserves forced, required and disabled tool choice semantics", () => {
    const body = { contents: [{ role: "user", parts: [{ text: "invoke lookup" }] }], tools: [{ functionDeclarations: [{ name: "lookup" }, { name: "check" }] }] };
    const forced = translate({ ...body, toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] } } });
    expect(forced.tool_choice).toEqual({ type: "function", function: { name: "lookup" } });
    expect(forced.tools.map((tool) => tool.function.name)).toEqual(["lookup"]);
    expect(translate({ ...body, toolConfig: { functionCallingConfig: { mode: "ANY" } } }).tool_choice).toBe("required");
    expect(translate({ ...body, toolConfig: { functionCallingConfig: { mode: "NONE" } } }).tool_choice).toBe("none");
    expect(() => translate({ ...body, toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["not_declared"] } } })).toThrow(/declared tools/);
  });

  it.each([
    { fileData: { mimeType: "application/pdf", fileUri: "gs://test/document" } },
    { inlineData: { mimeType: "audio/wav", data: "aGVsbG8=" } },
    { videoMetadata: { startOffset: "0s" } },
    { futureContent: { value: "retain or reject" } },
  ])("rejects unsupported cross-format parts instead of losing them: %j", (part) => {
    const body = { contents: [{ role: "user", parts: [{ functionResponse: { name: "lookup", response: { value: 1 } } }, part, { text: "must not vanish" }] }] };
    expect(() => translate(body)).toThrow(/native Gemini route/);
    try { translate(body); } catch (error) { expect(error.code).toBe("unsupported_request"); }
  });
});
