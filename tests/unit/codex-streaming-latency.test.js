import { describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("Codex streaming latency and tool call optimizations", () => {
  describe("CodexExecutor._peekSseOverloaded", () => {
    it("breaks early on active generation frame without waiting for full buffer or delayed chunks", async () => {
      const executor = new CodexExecutor();
      let chunk2Released = false;
      let resolveChunk3;
      const chunk3Promise = new Promise((r) => {
        resolveChunk3 = r;
      });

      const chunks = [
        new TextEncoder().encode('event: response.created\ndata: {"id":"resp_123","status":"in_progress"}\n\n'),
        new TextEncoder().encode('event: response.output_text.delta\ndata: {"delta":"Hello"}\n\n'),
        new TextEncoder().encode('event: response.completed\ndata: {"response":{"status":"completed"}}\n\n'),
      ];

      let streamIndex = 0;
      const mockStream = new ReadableStream({
        async pull(controller) {
          if (streamIndex === 0) {
            controller.enqueue(chunks[0]);
            streamIndex++;
          } else if (streamIndex === 1) {
            controller.enqueue(chunks[1]);
            streamIndex++;
            chunk2Released = true;
          } else if (streamIndex === 2) {
            await chunk3Promise;
            controller.enqueue(chunks[2]);
            streamIndex++;
            controller.close();
          }
        },
      });

      const mockResponse = new Response(mockStream, { status: 200, statusText: "OK" });

      // _peekSseOverloaded should resolve immediately after chunk 1 (output_text.delta),
      // WITHOUT waiting for chunk 3 to resolve!
      const peekPromise = executor._peekSseOverloaded(mockResponse);
      const peek = await Promise.race([
        peekPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout: _peekSseOverloaded blocked on delayed chunk")), 500)),
      ]);

      expect(chunk2Released).toBe(true);
      expect(peek.matched).toBeNull();
      expect(peek.replacementBody).toBeDefined();

      // Now resolve chunk 3 and consume replacementBody
      resolveChunk3();
      const reader = peek.replacementBody.getReader();
      const decoded = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        decoded.push(new TextDecoder().decode(value));
      }
      const fullText = decoded.join("");
      expect(fullText).toContain("Hello");
      expect(fullText).toContain("completed");
    });

    it("detects server_is_overloaded error pattern", async () => {
      const executor = new CodexExecutor();
      const chunks = [
        new TextEncoder().encode('event: error\ndata: {"error":{"message":"server_is_overloaded"}}\n\n'),
      ];

      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(chunks[0]);
          controller.close();
        },
      });

      const mockResponse = new Response(mockStream, { status: 200, statusText: "OK" });
      const peek = await executor._peekSseOverloaded(mockResponse);

      expect(peek.matched).toBe("server_is_overloaded");
    });

    it("does not treat normal output containing server_is_overloaded as an upstream error", async () => {
      const executor = new CodexExecutor();
      const chunks = [
        new TextEncoder().encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"The error identifier is server_is_overloaded"}\n\n'),
      ];

      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(chunks[0]);
          controller.close();
        },
      });

      const mockResponse = new Response(mockStream, { status: 200, statusText: "OK" });
      const peek = await executor._peekSseOverloaded(mockResponse);

      // Must release immediately without treating generated text as an error
      expect(peek.matched).toBeNull();
      expect(peek.replacementBody).toBeDefined();
    });

    it("detects overload frame appearing after 2048 bytes of metadata", async () => {
      const executor = new CodexExecutor();
      // Pad with 2500 bytes of comments/metadata before the overload error
      const padding = `: keepalive padding ${"x".repeat(100)}\n\n`.repeat(25);
      const chunks = [
        new TextEncoder().encode(padding),
        new TextEncoder().encode('event: error\ndata: {"error":{"message":"service_unavailable_error"}}\n\n'),
      ];

      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(chunks[0]);
          controller.enqueue(chunks[1]);
          controller.close();
        },
      });

      const mockResponse = new Response(mockStream, { status: 200, statusText: "OK" });
      const peek = await executor._peekSseOverloaded(mockResponse);

      expect(peek.matched).toBe("service_unavailable_error");
    });

    it("detects plain-text server_is_overloaded error in event: error", async () => {
      const executor = new CodexExecutor();
      const chunks = [
        new TextEncoder().encode("event: error\ndata: server_is_overloaded\n\n"),
      ];

      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(chunks[0]);
          controller.close();
        },
      });

      const mockResponse = new Response(mockStream, { status: 200, statusText: "OK" });
      const peek = await executor._peekSseOverloaded(mockResponse);

      expect(peek.matched).toBe("server_is_overloaded");
    });

    it("detects active generation frame with CR-only delimiters", async () => {
      const executor = new CodexExecutor();
      const chunks = [
        new TextEncoder().encode('event: response.output_text.delta\rdata: {"type":"response.output_text.delta","delta":"Fast token"}\r\r'),
      ];

      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(chunks[0]);
          controller.close();
        },
      });

      const mockResponse = new Response(mockStream, { status: 200, statusText: "OK" });
      const peek = await executor._peekSseOverloaded(mockResponse);

      expect(peek.matched).toBeNull();
      expect(peek.replacementBody).toBeDefined();
    });
  });

  describe("CodexExecutor strict property preservation", () => {
    it("preserves strict boolean flag on tools", () => {
      const executor = new CodexExecutor();
      const body = {
        model: "gpt-5.6-sol",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        tools: [
          {
            type: "function",
            name: "strict_tool",
            description: "A strict tool",
            parameters: { type: "object", properties: { a: { type: "string" } } },
            strict: true,
          },
          {
            type: "function",
            name: "non_strict_tool",
            description: "A non strict tool",
            parameters: { type: "object", properties: { b: { type: "string" } } },
            strict: false,
          },
        ],
        stream: true,
      };

      executor.transformRequest("gpt-5.6-sol", body, true, {});
      expect(body.tools).toHaveLength(2);
      expect(body.tools[0].strict).toBe(true);
      expect(body.tools[1].strict).toBe(false);
    });
  });

  describe("openaiToOpenAIResponsesRequest tool and instructions handling", () => {
    it("preserves initial instructions and mid-conversation developer turns", () => {
      const body = {
        messages: [
          { role: "system", content: "Initial system instruction" },
          { role: "user", content: "User task 1" },
          { role: "developer", content: "Mid-turn instruction" },
          { role: "user", content: "User task 2" },
        ],
      };

      const result = openaiToOpenAIResponsesRequest("gpt-5.6-sol", body, true, null);
      expect(result.instructions).toBe("Initial system instruction");
      expect(result.input).toHaveLength(3);
      expect(result.input[0].role).toBe("user");
      expect(result.input[1].role).toBe("developer");
      expect(result.input[1].content[0].text).toBe("Mid-turn instruction");
      expect(result.input[2].role).toBe("user");
    });

    it("passes through validated tool_choice and normalizes function call arguments", () => {
      const body = {
        messages: [
          { role: "user", content: "Run bash" },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call_abc123",
                function: {
                  name: "Bash",
                  arguments: { command: "ls -la" }, // object instead of string
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_abc123",
            content: "total 0",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "Bash",
              description: "Execute bash command",
              parameters: { type: "object", properties: { command: { type: "string" } } },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "Bash" } },
      };

      const result = openaiToOpenAIResponsesRequest("gpt-5.6-sol", body, true, null);

      expect(result.tool_choice).toEqual({ type: "function", name: "Bash" });
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe("Bash");

      // Verify function_call in input has stringified arguments
      const funcCall = result.input.find((i) => i.type === "function_call");
      expect(funcCall).toBeDefined();
      expect(funcCall.arguments).toBe('{"command":"ls -la"}');
      expect(funcCall.call_id).toBe("call_abc123");

      // Verify function_call_output in input maps to same call_id
      const funcOutput = result.input.find((i) => i.type === "function_call_output");
      expect(funcOutput).toBeDefined();
      expect(funcOutput.output).toBe("total 0");
      expect(funcOutput.call_id).toBe(funcCall.call_id);
    });

    it("validates tool_choice string options and rejects undeclared function choices", () => {
      const resultAuto = openaiToOpenAIResponsesRequest("gpt-5.6-sol", { tool_choice: "auto" }, true, null);
      expect(resultAuto.tool_choice).toBe("auto");

      const resultRequired = openaiToOpenAIResponsesRequest("gpt-5.6-sol", { tool_choice: "required" }, true, null);
      expect(resultRequired.tool_choice).toBe("required");

      // Invalid string choice must fail closed
      expect(() => {
        openaiToOpenAIResponsesRequest("gpt-5.6-sol", { tool_choice: "invalid_choice" }, true, null);
      }).toThrow(/Invalid tool_choice string value/);

      // Undeclared function tool_choice must fail closed
      expect(() => {
        openaiToOpenAIResponsesRequest("gpt-5.6-sol", {
          tool_choice: { type: "function", name: "NonExistent" },
          tools: [{ type: "function", function: { name: "Bash" } }]
        }, true, null);
      }).toThrow(/is not declared in tools/);
    });

    it("pairs ID-less tool calls and ID-less tool outputs accurately", () => {
      const body = {
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                function: { name: "ToolA", arguments: '{"x":1}' }
              },
              {
                function: { name: "ToolB", arguments: '{"y":2}' }
              }
            ]
          },
          {
            role: "tool",
            content: "output A"
          },
          {
            role: "tool",
            content: "output B"
          }
        ]
      };

      const result = openaiToOpenAIResponsesRequest("gpt-5.6-sol", body, true, null);
      const callA = result.input.find(i => i.type === "function_call" && i.name === "ToolA");
      const callB = result.input.find(i => i.type === "function_call" && i.name === "ToolB");
      const outputs = result.input.filter(i => i.type === "function_call_output");

      expect(callA).toBeDefined();
      expect(callB).toBeDefined();
      expect(outputs).toHaveLength(2);
      expect(outputs[0].call_id).toBe(callA.call_id);
      expect(outputs[1].call_id).toBe(callB.call_id);
    });

    it("throws a validation error when tool arguments cannot be serialized", () => {
      const circular = {};
      circular.self = circular;

      const body = {
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call_bad",
                function: {
                  name: "BadTool",
                  arguments: circular,
                },
              },
            ],
          },
        ],
      };

      expect(() => {
        openaiToOpenAIResponsesRequest("gpt-5.6-sol", body, true, null);
      }).toThrow(/Failed to serialize arguments for tool/);
    });
  });

  describe("stream.js Responses API event tracking", () => {
    it("accumulates content and toolCalls from Responses stream in onStreamComplete", async () => {
      let completedResult = null;
      const onStreamComplete = vi.fn((res) => {
        completedResult = res;
      });

      const stream = createSSETransformStreamWithLogger(
        FORMATS.OPENAI_RESPONSES,
        FORMATS.CLAUDE,
        "codex",
        null,
        null,
        "gpt-5.6-sol",
        "test-conn",
        {},
        onStreamComplete
      );

      // Concurrently read from readable to prevent TransformStream backpressure deadlock
      const reader = stream.readable.getReader();
      const readPromise = (async () => {
        const received = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received.push(value);
        }
        return received;
      })();

      const writer = stream.writable.getWriter();
      const ssePayload = [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Running tool..."}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_999","name":"Bash"}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"call_999","delta":"{\\"cmd\\":\\"git status\\"}"}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_999","name":"Bash"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":100,"output_tokens":50}}}\n\n',
        'data: [DONE]\n\n',
      ];

      for (const chunk of ssePayload) {
        await writer.write(new TextEncoder().encode(chunk));
      }
      await writer.close();
      await readPromise;

      expect(onStreamComplete).toHaveBeenCalled();
      expect(completedResult).toBeDefined();
      expect(completedResult.content).toBe("Running tool...");
      expect(completedResult.toolCalls).toHaveLength(1);
      expect(completedResult.toolCalls[0].name).toBe("Bash");
      expect(completedResult.toolCalls[0].id).toBe("call_999");
    });

    it("reconciles discrepant item.id and item.call_id without duplicate toolCall entries", async () => {
      let completedResult = null;
      const onStreamComplete = vi.fn((res) => {
        completedResult = res;
      });

      const stream = createSSETransformStreamWithLogger(
        FORMATS.OPENAI_RESPONSES,
        FORMATS.CLAUDE,
        "codex",
        null,
        null,
        "gpt-5.6-sol",
        "test-conn",
        {},
        onStreamComplete
      );

      const reader = stream.readable.getReader();
      const readPromise = (async () => {
        const received = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received.push(value);
        }
        return received;
      })();

      const writer = stream.writable.getWriter();
      // Upstream sends item.id = "fc_item_123" and item.call_id = "call_999"
      // Delta events reference item_id = "fc_item_123"
      const ssePayload = [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_2"}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"fc_item_123","call_id":"call_999","type":"function_call","name":"ReadFile"}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_item_123","delta":"{\\"path\\":\\"src/index.js\\"}"}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"fc_item_123","call_id":"call_999","type":"function_call","name":"ReadFile"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":50,"output_tokens":30}}}\n\n',
        'data: [DONE]\n\n',
      ];

      for (const chunk of ssePayload) {
        await writer.write(new TextEncoder().encode(chunk));
      }
      await writer.close();
      await readPromise;

      expect(onStreamComplete).toHaveBeenCalled();
      expect(completedResult).toBeDefined();
      // Must NOT produce 2 items (one for fc_item_123 and one for call_999)
      expect(completedResult.toolCalls).toHaveLength(1);
      expect(completedResult.toolCalls[0].id).toBe("call_999");
      expect(completedResult.toolCalls[0].name).toBe("ReadFile");
    });

    it("handles late alias reconciliation when item_id appears in delta and merges on done", async () => {
      let completedResult = null;
      const onStreamComplete = vi.fn((res) => {
        completedResult = res;
      });

      const stream = createSSETransformStreamWithLogger(
        FORMATS.OPENAI_RESPONSES,
        FORMATS.CLAUDE,
        "codex",
        null,
        null,
        "gpt-5.6-sol",
        "test-conn",
        {},
        onStreamComplete
      );

      const reader = stream.readable.getReader();
      const readPromise = (async () => {
        const received = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received.push(value);
        }
        return received;
      })();

      const writer = stream.writable.getWriter();
      // Sequence:
      // 1. added: call_id="call_1", no item ID
      // 2. delta: item_id="fc_1"
      // 3. done: both id="fc_1" and call_id="call_1"
      const ssePayload = [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_3"}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"call_id":"call_1","type":"function_call","name":"LateTool"}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"a\\":1}"}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"fc_1","call_id":"call_1","type":"function_call","name":"LateTool"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        'data: [DONE]\n\n',
      ];

      for (const chunk of ssePayload) {
        await writer.write(new TextEncoder().encode(chunk));
      }
      await writer.close();
      await readPromise;

      expect(onStreamComplete).toHaveBeenCalled();
      expect(completedResult).toBeDefined();
      // Must merge both entries into exactly 1 tool call
      expect(completedResult.toolCalls).toHaveLength(1);
      expect(completedResult.toolCalls[0].id).toBe("call_1");
      expect(completedResult.toolCalls[0].name).toBe("LateTool");
    });

    it("bounds tool call tracking when receiving many tool items", async () => {
      let completedResult = null;
      const onStreamComplete = vi.fn((res) => {
        completedResult = res;
      });

      const stream = createSSETransformStreamWithLogger(
        FORMATS.OPENAI_RESPONSES,
        FORMATS.CLAUDE,
        "codex",
        null,
        null,
        "gpt-5.6-sol",
        "test-conn",
        {},
        onStreamComplete
      );

      const reader = stream.readable.getReader();
      const readPromise = (async () => {
        const received = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received.push(value);
        }
        return received;
      })();

      const writer = stream.writable.getWriter();
      await writer.write(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_bound"}}\n\n'));

      // Emit 200 distinct tool call items
      for (let i = 0; i < 200; i++) {
        await writer.write(new TextEncoder().encode(`event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"item_${i}","call_id":"call_${i}","type":"function_call","name":"tool_${i}"}}\n\n`));
      }

      await writer.write(new TextEncoder().encode('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'));
      await writer.write(new TextEncoder().encode('data: [DONE]\n\n'));
      await writer.close();
      await readPromise;

      expect(onStreamComplete).toHaveBeenCalled();
      expect(completedResult).toBeDefined();
      // Must be capped at MAX_TRACKED_TOOL_CALLS (64)
      expect(completedResult.toolCalls.length).toBeLessThanOrEqual(64);
    });

    it("redirects all aliases pointing to the merged record", async () => {
      let completedResult = null;
      const onStreamComplete = vi.fn((res) => {
        completedResult = res;
      });

      const stream = createSSETransformStreamWithLogger(
        FORMATS.OPENAI_RESPONSES,
        FORMATS.CLAUDE,
        "codex",
        null,
        null,
        "gpt-5.6-sol",
        "test-conn",
        {},
        onStreamComplete
      );

      const reader = stream.readable.getReader();
      const readPromise = (async () => {
        const received = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received.push(value);
        }
        return received;
      })();

      const writer = stream.writable.getWriter();
      const ssePayload = [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_m"}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"call_id":"call_root","type":"function_call","name":"RootTool"}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"alias_1","delta":"{\\"x\\":1}"}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"alias_1","call_id":"call_root","type":"function_call","name":"RootTool"}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"alias_1","delta":"{\\"x\\":2}"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        'data: [DONE]\n\n',
      ];

      for (const chunk of ssePayload) {
        await writer.write(new TextEncoder().encode(chunk));
      }
      await writer.close();
      await readPromise;

      expect(onStreamComplete).toHaveBeenCalled();
      expect(completedResult.toolCalls).toHaveLength(1);
      expect(completedResult.toolCalls[0].id).toBe("call_root");
    });
  });
});
