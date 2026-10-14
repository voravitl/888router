import { describe, it, expect } from "vitest";
import {
  normalizeGeminiContents,
  sanitizeFunctionResponsePayload,
  openaiToGeminiRequest,
} from "../../open-sse/translator/request/openai-to-gemini.js";

describe("functionResponse `$ref` sanitization", () => {
  const schemaResult = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $ref: "#/$defs/Config",
    $defs: { Config: { properties: { a: { $ref: "#/$defs/A" } } } },
    list: [{ $ref: "#/$defs/B" }, "plain", 5, null]
  };

  it("renames `$ref` keys recursively and leaves other values untouched", () => {
    const out = sanitizeFunctionResponsePayload(schemaResult);
    expect(out.$ref).toBeUndefined();
    expect(out._ref).toBe("#/$defs/Config");
    expect(out.$defs.Config.properties.a._ref).toBe("#/$defs/A");
    expect(out.list).toEqual([{ _ref: "#/$defs/B" }, "plain", 5, null]);
    expect(out.$schema).toBe(schemaResult.$schema);
    expect(sanitizeFunctionResponsePayload("str")).toBe("str");
    expect(sanitizeFunctionResponsePayload(null)).toBeNull();
  });

  it("normalizeGeminiContents sanitizes functionResponse without mutating input", () => {
    const contents = [
      { role: "user", parts: [{ text: "go" }] },
      { role: "model", parts: [{ functionCall: { id: "c1", name: "webfetch", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "c1", name: "webfetch", response: { result: schemaResult } } }] }
    ];
    const out = normalizeGeminiContents(contents);
    const resp = out[2].parts[0].functionResponse.response;
    expect(JSON.stringify(resp)).not.toContain('"$ref"');
    expect(resp.result._ref).toBe("#/$defs/Config");
    expect(contents[2].parts[0].functionResponse.response.result.$ref).toBe("#/$defs/Config");
  });

  it("openai -> gemini translation of a JSON-schema tool result carries no `$ref` key", () => {
    const body = {
      messages: [
        { role: "user", content: "fetch it" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "webfetch", arguments: "{}" } }]
        },
        { role: "tool", tool_call_id: "call_1", content: JSON.stringify(schemaResult) },
        { role: "user", content: "thanks" }
      ]
    };
    const out = openaiToGeminiRequest("gemini-3-flash", body, true);
    const frs = out.contents.flatMap(c => c.parts).filter(p => p.functionResponse);
    expect(frs).toHaveLength(1);
    expect(JSON.stringify(frs[0].functionResponse.response)).not.toContain('"$ref"');
    expect(frs[0].functionResponse.response.result._ref).toBe("#/$defs/Config");
  });
});
