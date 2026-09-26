import { describe, it, expect, vi } from "vitest";
import {
  OPENCODE_TOOL_NAME_PATTERN,
  sanitizeToolName,
  sanitizeOpencodeTools,
  restoreOpencodeToolNames,
} from "../../open-sse/utils/opencodeToolSanitizer.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({ choices: [{ message: { content: "ok" } }] }),
  })),
}));

describe("opencodeToolSanitizer — unit tests", () => {
  it("recognizes valid OpenAI / Console tool names", () => {
    expect(OPENCODE_TOOL_NAME_PATTERN.test("code_review")).toBe(true);
    expect(OPENCODE_TOOL_NAME_PATTERN.test("run-test")).toBe(true);
    expect(OPENCODE_TOOL_NAME_PATTERN.test("mcp.fs.read")).toBe(true);
    expect(OPENCODE_TOOL_NAME_PATTERN.test("bash")).toBe(true);
    expect(OPENCODE_TOOL_NAME_PATTERN.test("tool123")).toBe(true);

    // Characters rejected by Console:
    expect(OPENCODE_TOOL_NAME_PATTERN.test("code-review:code-review")).toBe(false);
    expect(OPENCODE_TOOL_NAME_PATTERN.test("server/tool")).toBe(false);
    expect(OPENCODE_TOOL_NAME_PATTERN.test("plugin@v1")).toBe(false);
    expect(OPENCODE_TOOL_NAME_PATTERN.test("tool with spaces")).toBe(false);
  });

  describe("sanitizeToolName", () => {
    it("preserves already valid names", () => {
      const used = new Set();
      expect(sanitizeToolName("my_tool", used)).toBe("my_tool");
      expect(sanitizeToolName("tool-1.0", used)).toBe("tool-1.0");
    });

    it("replaces colons and other illegal characters with underscores", () => {
      const used = new Set();
      expect(sanitizeToolName("code-review:code-review", used)).toBe("code-review_code-review");
      expect(sanitizeToolName("server:tool/action@v1", used)).toBe("server_tool_action_v1");
      expect(sanitizeToolName("hello world!", used)).toBe("hello_world_");
    });

    it("handles collisions with existing or previously sanitized names", () => {
      const used = new Set();
      const first = sanitizeToolName("code-review:run", used);
      expect(first).toBe("code-review_run");
      expect(used.has("code-review_run")).toBe(true);

      const second = sanitizeToolName("code-review_run", used);
      expect(second).toBe("code-review_run_2");
      expect(used.has("code-review_run_2")).toBe(true);

      const third = sanitizeToolName("code-review/run", used);
      expect(third).toBe("code-review_run_3");
    });

    it("handles empty or degenerate strings gracefully", () => {
      const used = new Set();
      expect(sanitizeToolName("", used)).toBe("");
      expect(sanitizeToolName("   ", used)).toBe("");
      expect(sanitizeToolName("::::", used)).toBe("____");
    });
  });

  describe("sanitizeOpencodeTools", () => {
    it("sanitizes Chat function tools and updates tool_choice", () => {
      const body = {
        tools: [
          {
            type: "function",
            function: {
              name: "code-review:code-review",
              description: "Review code",
              parameters: { type: "object", properties: {} },
            },
          },
          {
            type: "function",
            function: {
              name: "bash",
              description: "Execute bash",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: { name: "code-review:code-review" },
        },
      };

      const map = sanitizeOpencodeTools(body);

      expect(body.tools[0].function.name).toBe("code-review_code-review");
      expect(body.tools[1].function.name).toBe("bash");
      expect(body.tool_choice.function.name).toBe("code-review_code-review");

      expect(map.size).toBe(1);
      expect(map.get("code-review_code-review")).toBe("code-review:code-review");
    });

    it("sanitizes flat tools shape (Responses API)", () => {
      const body = {
        tools: [
          {
            type: "function",
            name: "code-review:code-review",
            description: "Review code",
            parameters: { type: "object", properties: {} },
          },
        ],
        tool_choice: {
          type: "function",
          name: "code-review:code-review",
        },
      };

      const map = sanitizeOpencodeTools(body);

      expect(body.tools[0].name).toBe("code-review_code-review");
      expect(body.tool_choice.name).toBe("code-review_code-review");
      expect(map.get("code-review_code-review")).toBe("code-review:code-review");
    });

    it("sanitizes previous tool_calls in message history and Responses input items", () => {
      const body = {
        tools: [
          {
            type: "function",
            function: { name: "plugin:check" },
          },
        ],
        messages: [
          {
            role: "assistant",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "plugin:check", arguments: "{}" } },
            ],
          },
          {
            role: "tool",
            name: "plugin:check",
            content: "done",
          },
        ],
        input: [
          { type: "function_call", name: "plugin:check", call_id: "c_1" },
          { type: "function_call_output", name: "plugin:check", call_id: "c_1", output: "ok" },
        ],
      };

      const map = sanitizeOpencodeTools(body);

      expect(body.tools[0].function.name).toBe("plugin_check");
      expect(body.messages[0].tool_calls[0].function.name).toBe("plugin_check");
      expect(body.messages[1].name).toBe("plugin_check");
      expect(body.input[0].name).toBe("plugin_check");
      expect(body.input[1].name).toBe("plugin_check");
      expect(map.get("plugin_check")).toBe("plugin:check");
    });

    it("does not mutate original tool objects in place (immutability)", () => {
      const originalTool = {
        type: "function",
        function: { name: "my:special:tool", description: "testing" },
      };
      const body = {
        tools: [originalTool],
      };

      const map = sanitizeOpencodeTools(body);
      expect(originalTool.function.name).toBe("my:special:tool");
      expect(body.tools[0].function.name).toBe("my_special_tool");
      expect(body.tools[0]).not.toBe(originalTool);
      expect(map.get("my_special_tool")).toBe("my:special:tool");
    });

    it("is idempotent across retries and re-transformations", () => {
      const body = {
        tools: [
          {
            type: "function",
            function: { name: "code-review:code-review" },
          },
        ],
      };

      const map1 = sanitizeOpencodeTools(body);
      expect(map1.get("code-review_code-review")).toBe("code-review:code-review");
      expect(body.tools[0].function.name).toBe("code-review_code-review");

      // Simulate retry or second transform pass on the already-sanitized body
      const map2 = sanitizeOpencodeTools(body);
      expect(map2.get("code-review_code-review")).toBe("code-review:code-review");
      expect(body.tools[0].function.name).toBe("code-review_code-review");
    });

    it("prevents collision when an invalid name sanitizes into an existing valid name", () => {
      const body = {
        tools: [
          {
            type: "function",
            function: { name: "foo:bar" }, // would sanitize to foo_bar
          },
          {
            type: "function",
            function: { name: "foo_bar" }, // already valid
          },
        ],
      };

      const map = sanitizeOpencodeTools(body);
      const names = body.tools.map((t) => t.function.name);
      expect(names).toEqual(["foo_bar_2", "foo_bar"]);
      expect(map.get("foo_bar_2")).toBe("foo:bar");
      expect(map.has("foo_bar")).toBe(false);
    });
  });

  describe("restoreOpencodeToolNames", () => {
    const map = new Map([
      ["code-review_code-review", "code-review:code-review"],
    ]);

    it("restores tool name in Claude streaming chunk", () => {
      const chunk = {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "t_1", name: "code-review_code-review" },
      };
      const restored = restoreOpencodeToolNames(chunk, map);
      expect(restored.content_block.name).toBe("code-review:code-review");
    });

    it("restores tool name in Claude non-streaming message body", () => {
      const body = {
        id: "msg_1",
        type: "message",
        content: [
          { type: "tool_use", id: "t_1", name: "code-review_code-review", input: {} },
        ],
      };
      const restored = restoreOpencodeToolNames(body, map);
      expect(restored.content[0].name).toBe("code-review:code-review");
    });

    it("restores tool name in OpenAI Chat streaming chunk", () => {
      const chunk = {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c_1", function: { name: "code-review_code-review" } },
              ],
            },
          },
        ],
      };
      const restored = restoreOpencodeToolNames(chunk, map);
      expect(restored.choices[0].delta.tool_calls[0].function.name).toBe("code-review:code-review");
    });

    it("restores tool name in OpenAI Chat non-streaming body", () => {
      const body = {
        choices: [
          {
            message: {
              tool_calls: [
                { id: "c_1", function: { name: "code-review_code-review", arguments: "{}" } },
              ],
            },
          },
        ],
      };
      const restored = restoreOpencodeToolNames(body, map);
      expect(restored.choices[0].message.tool_calls[0].function.name).toBe("code-review:code-review");
    });

    it("restores tool name in Responses SSE item event and JSON output", () => {
      const event = {
        type: "response.output_item.added",
        item: { id: "item_1", type: "function_call", name: "code-review_code-review" },
      };
      expect(restoreOpencodeToolNames(event, map).item.name).toBe("code-review:code-review");

      const jsonBody = {
        output: [
          { type: "function_call", name: "code-review_code-review" },
        ],
      };
      expect(restoreOpencodeToolNames(jsonBody, map).output[0].name).toBe("code-review:code-review");
    });
  });

  describe("OpenCodeExecutor integration", () => {
    it("sanitizes invalid tool names and attaches _toolNameMap in transformRequest", () => {
      const executor = new OpenCodeExecutor();
      const body = {
        messages: [{ role: "user", content: "Review this" }],
        tools: [
          {
            type: "function",
            function: {
              name: "code-review:code-review",
              description: "Deep code review",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      };

      const transformed = executor.transformRequest("space-bunny-free", body, true, {});

      expect(transformed._toolNameMap).toBeInstanceOf(Map);
      expect(transformed._toolNameMap.get("code-review_code-review")).toBe("code-review:code-review");
      for (const t of transformed.tools) {
        const name = t.function?.name || t.name;
        expect(OPENCODE_TOOL_NAME_PATTERN.test(name)).toBe(true);
      }
    });

    it("cleans _toolNameMap before outbound fetch and returns toolNameMap from execute", async () => {
      proxyAwareFetch.mockClear();
      const executor = new OpenCodeExecutor();
      const body = {
        messages: [{ role: "user", content: "Review this" }],
        tools: [
          {
            type: "function",
            function: {
              name: "code-review:code-review",
              description: "Deep code review",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      };

      const result = await executor.execute({
        model: "space-bunny-free",
        body,
        stream: true,
        credentials: { connectionId: "test-sanitizer" },
      });

      expect(result.toolNameMap).toBeInstanceOf(Map);
      expect(result.toolNameMap.get("code-review_code-review")).toBe("code-review:code-review");

      expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
      const [, init] = proxyAwareFetch.mock.calls[0];
      const sent = JSON.parse(init.body);
      expect(sent._toolNameMap).toBeUndefined();
      for (const t of sent.tools) {
        const name = t.function?.name || t.name;
        expect(OPENCODE_TOOL_NAME_PATTERN.test(name)).toBe(true);
      }
    });
  });

  describe("translateResponse toolNameMap integration", () => {
    it("restores tool names in same-format streaming passthrough", async () => {
      const { translateResponse } = await import("../../open-sse/translator/index.js");
      const { FORMATS } = await import("../../open-sse/translator/formats.js");

      const map = new Map([["code-review_code-review", "code-review:code-review"]]);
      const chunk = {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: "code-review_code-review" } },
              ],
            },
          },
        ],
      };

      const [translated] = translateResponse(FORMATS.OPENAI, FORMATS.OPENAI, chunk, { toolNameMap: map });
      expect(translated.choices[0].delta.tool_calls[0].function.name).toBe("code-review:code-review");
    });
  });
});
