/**
 * Unit tests for open-sse/translator/request/openai-to-claude.js
 *
 * Tests cover:
 *  - openaiToClaudeRequest() - OpenAI to Claude request translation
 *  - Response format handling (json_schema, json_object)
 */

import { describe, it, expect } from "vitest";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

describe("openaiToClaudeRequest", () => {
  describe("response_format handling", () => {
    it("should inject JSON schema instructions for json_schema type", () => {
      const body = {
        messages: [{ role: "user", content: "What is 2+2?" }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "math_response",
            schema: {
              type: "object",
              properties: {
                answer: { type: "number" },
                explanation: { type: "string" }
              },
              required: ["answer", "explanation"]
            }
          }
        }
      };

      const result = openaiToClaudeRequest("claude-sonnet-4.5", body, false);

      // Should have system array with instructions
      expect(result.system).toBeDefined();
      expect(Array.isArray(result.system)).toBe(true);
      
      // Check that system prompt includes schema
      const systemText = result.system
        .filter(s => s.type === "text")
        .map(s => s.text)
        .join("\n");
      
      expect(systemText).toContain("You must respond with valid JSON");
      expect(systemText).toContain("\"answer\"");
      expect(systemText).toContain("\"explanation\"");
      expect(systemText).toContain("Respond ONLY with the JSON object");
    });

    it("should inject basic JSON instructions for json_object type", () => {
      const body = {
        messages: [{ role: "user", content: "Give me a JSON object" }],
        response_format: {
          type: "json_object"
        }
      };

      const result = openaiToClaudeRequest("claude-sonnet-4.5", body, false);

      // Should have system array with instructions
      expect(result.system).toBeDefined();
      expect(Array.isArray(result.system)).toBe(true);
      
      const systemText = result.system
        .filter(s => s.type === "text")
        .map(s => s.text)
        .join("\n");
      
      expect(systemText).toContain("You must respond with valid JSON");
      expect(systemText).toContain("Respond ONLY with a JSON object");
    });

    it("should not modify system prompt when response_format is missing", () => {
      const body = {
        messages: [{ role: "user", content: "Hello" }]
      };

      const result = openaiToClaudeRequest("claude-sonnet-4.5", body, false);

      // Should have system but without JSON instructions
      expect(result.system).toBeDefined();
      
      const systemText = result.system
        .filter(s => s.type === "text")
        .map(s => s.text)
        .join("\n");
      
      // Should NOT contain JSON-specific instructions
      expect(systemText).not.toContain("You must respond with valid JSON");
    });

    it("should preserve existing system messages when adding response_format", () => {
      const body = {
        messages: [
          { role: "system", content: "You are a helpful math tutor." },
          { role: "user", content: "What is 2+2?" }
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            schema: {
              type: "object",
              properties: {
                result: { type: "number" }
              }
            }
          }
        }
      };

      const result = openaiToClaudeRequest("claude-sonnet-4.5", body, false);

      // Should preserve original system message
      const systemText = result.system
        .filter(s => s.type === "text")
        .map(s => s.text)
        .join("\n");
      
      expect(systemText).toContain("You are a helpful math tutor");
      expect(systemText).toContain("You must respond with valid JSON");
    });
  });

  describe("tool_choice handling", () => {
    const baseBody = {
      messages: [{ role: "user", content: "add a todo" }],
      tools: [{
        type: "function",
        function: { name: "todo_write", description: "write todos", parameters: { type: "object", properties: {} } }
      }]
    };

    const choiceOf = (tc) =>
      openaiToClaudeRequest("claude-sonnet-4.5", { ...baseBody, tool_choice: tc }, false).tool_choice;

    it("converts OpenAI forced tool ({type:'function'}) to Claude {type:'tool'}", () => {
      // Must NOT leak the OpenAI "function" type — Claude only accepts auto|any|tool|none.
      expect(choiceOf({ type: "function", function: { name: "todo_write" } }))
        .toEqual({ type: "tool", name: "todo_write" });
    });

    it("maps string tool_choice values", () => {
      expect(choiceOf("auto")).toEqual({ type: "auto" });
      expect(choiceOf("none")).toEqual({ type: "none" });
      expect(choiceOf("required")).toEqual({ type: "any" });
    });

    it("passes through Claude-native tool_choice objects unchanged", () => {
      expect(choiceOf({ type: "tool", name: "todo_write" })).toEqual({ type: "tool", name: "todo_write" });
      expect(choiceOf({ type: "any" })).toEqual({ type: "any" });
      expect(choiceOf({ type: "none" })).toEqual({ type: "none" });
    });

    it("never leaks an invalid type (falls back to auto)", () => {
      // Malformed forced choice with no tool name, and unknown types, must not
      // pass an invalid `type` through to Claude.
      expect(choiceOf({ type: "function", function: {} })).toEqual({ type: "auto" });
      expect(choiceOf({ type: "function" })).toEqual({ type: "auto" });
      expect(choiceOf({ type: "bogus" })).toEqual({ type: "auto" });
    });

    it("omits tool_choice entirely when the request has none", () => {
      const result = openaiToClaudeRequest("claude-sonnet-4.5", baseBody, false);
      expect(result.tool_choice).toBeUndefined();
    });
  });
});

describe("openaiToClaudeResponse", () => {
  it("omits empty Read pages tool argument before emitting Claude input deltas", () => {
    const state = { toolCalls: new Map() };
    const chunk = {
      id: "chatcmpl-test",
      model: "gpt-test",
      choices: [{
        finish_reason: "tool_calls",
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_read",
            function: {
              name: "Read",
              arguments: JSON.stringify({
                file_path: "/tmp/example.txt",
                offset: 0,
                limit: 120,
                pages: ""
              })
            }
          }]
        }
      }]
    };

    const result = openaiToClaudeResponse(chunk, state);
    const inputDelta = result.find(event => event.delta?.type === "input_json_delta");

    expect(inputDelta).toBeDefined();
    expect(JSON.parse(inputDelta.delta.partial_json)).toEqual({
      file_path: "/tmp/example.txt",
      offset: 0,
      limit: 120
    });
  });

  it("forwards whitespace-only deltas when a text block is already open", () => {
    const state = {
      messageStartSent: true,
      messageId: "msg_test",
      model: "m",
      nextBlockIndex: 1,
      thinkingBlockStarted: false,
      textBlockStarted: false,
      textBlockClosed: false,
      toolCalls: new Map()
    };
    const chunk = (content) => ({
      id: "chatcmpl-t",
      model: "m",
      choices: [{ finish_reason: null, delta: { content } }]
    });

    openaiToClaudeResponse(chunk("- item one"), state);
    const ws = openaiToClaudeResponse(chunk("\n"), state);
    const wsText = (ws || []).filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text).join("");
    expect(wsText).toBe("\n");
    openaiToClaudeResponse(chunk("- item two"), state);

    const finish = openaiToClaudeResponse(
      { id: "chatcmpl-t", model: "m", choices: [{ finish_reason: "stop", delta: {} }] },
      state
    );
    expect(finish).not.toBeNull();
  });

  it("drops a leading whitespace-only delta before any text block opens", () => {
    const state = {
      messageStartSent: true,
      messageId: "msg_test",
      model: "m",
      nextBlockIndex: 1,
      thinkingBlockStarted: false,
      textBlockStarted: false,
      textBlockClosed: false,
      leadingWhitespaceBuf: "",
      toolCalls: new Map()
    };
    const chunk = (content) => ({
      id: "chatcmpl-t",
      model: "m",
      choices: [{ finish_reason: null, delta: { content } }]
    });
    // Leading whitespace is buffered, then flushed when real text arrives.
    const ws = openaiToClaudeResponse(chunk("    "), state);
    expect((ws || []).filter((e) => e.delta?.type === "text_delta")).toHaveLength(0);
    const text = openaiToClaudeResponse(chunk("const x = 1;"), state);
    const texts = (text || []).filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text);
    expect(texts.join("")).toBe("    const x = 1;");
  });

  it("reopens a new text block for text arriving after close", () => {
    const state = {
      messageStartSent: true,
      messageId: "msg_test",
      model: "m",
      nextBlockIndex: 1,
      thinkingBlockStarted: false,
      textBlockStarted: false,
      textBlockClosed: false,
      leadingWhitespaceBuf: "",
      toolCalls: new Map()
    };
    const chunk = (content, finish = null) => ({
      id: "chatcmpl-t",
      model: "m",
      choices: [{ finish_reason: finish, delta: content ? { content } : {} }]
    });
    openaiToClaudeResponse(chunk("one"), state);
    openaiToClaudeResponse(chunk(null, "stop"), state);
    const reopen = openaiToClaudeResponse(chunk("two"), state);
    const starts = (reopen || []).filter((e) => e.type === "content_block_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].index).toBe(2);
    expect(state.textBlockClosed).toBe(false);
  });

  it("buffers whitespace arriving after a close for the next block", () => {
    const state = {
      messageStartSent: true,
      messageId: "msg_test",
      model: "m",
      nextBlockIndex: 1,
      thinkingBlockStarted: false,
      textBlockStarted: false,
      textBlockClosed: false,
      leadingWhitespaceBuf: "",
      toolCalls: new Map()
    };
    const chunk = (content, finish = null) => ({
      id: "chatcmpl-t",
      model: "m",
      choices: [{ finish_reason: finish, delta: content ? { content } : {} }]
    });
    openaiToClaudeResponse(chunk("one"), state);
    openaiToClaudeResponse(chunk(null, "stop"), state);
    openaiToClaudeResponse(chunk("\n  "), state);
    const reopen = openaiToClaudeResponse(chunk("two"), state);
    const texts = (reopen || []).filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text);
    expect(texts.join("")).toBe("\n  two");
  });

  it("clears buffered whitespace on abnormal termination", () => {
    const state = {
      messageStartSent: true,
      messageId: "msg_test",
      model: "m",
      nextBlockIndex: 1,
      thinkingBlockStarted: false,
      textBlockStarted: false,
      textBlockClosed: false,
      leadingWhitespaceBuf: "   ",
      toolCalls: new Map()
    };
    const result = openaiToClaudeResponse(null, state);
    expect(result).toBeNull();
    expect(state.leadingWhitespaceBuf).toBe("");
  });

  it("ignores usage chunks without touching buffered whitespace", () => {
    const state = {
      messageStartSent: true,
      messageId: "msg_test",
      model: "m",
      nextBlockIndex: 1,
      thinkingBlockStarted: false,
      textBlockStarted: false,
      textBlockClosed: false,
      leadingWhitespaceBuf: "   ",
      toolCalls: new Map()
    };
    const chunk = (content) => ({
      id: "chatcmpl-t",
      model: "m",
      choices: [{ finish_reason: null, delta: { content } }]
    });
    // Usage/metadata frame: no choices[0] — must not clear the buffer.
    const usage = openaiToClaudeResponse({ id: "chatcmpl-t", model: "m", usage: { prompt_tokens: 5, completion_tokens: 0 } }, state);
    expect(usage).toBeNull();
    const text = openaiToClaudeResponse(chunk("hi"), state);
    const texts = (text || []).filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text);
    expect(texts.join("")).toBe("   hi");
  });

  it("keeps a whitespace-only stream as an empty response", () => {
    const state = {
      messageStartSent: true,
      messageId: "msg_test",
      model: "m",
      nextBlockIndex: 1,
      thinkingBlockStarted: false,
      textBlockStarted: false,
      textBlockClosed: false,
      leadingWhitespaceBuf: "",
      toolCalls: new Map()
    };
    const chunk = (content) => ({
      id: "chatcmpl-t",
      model: "m",
      choices: [{ finish_reason: null, delta: { content } }]
    });
    openaiToClaudeResponse(chunk("   "), state);
    const finish = openaiToClaudeResponse(
      { id: "chatcmpl-t", model: "m", choices: [{ finish_reason: "stop", delta: {} }] },
      state
    );
    const deltas = (finish || []).filter((e) => e.delta?.type === "text_delta");
    expect(deltas).toHaveLength(0);
    expect(state.textBlockStarted).toBe(false);
  });
});
