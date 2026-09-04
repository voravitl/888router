import { describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("Codex streaming latency and tool call optimizations", () => {
  describe("CodexExecutor._peekSseOverloaded", () => {
    it("breaks early on response.created without stalling for full peek buffer", async () => {
      const executor = new CodexExecutor();
      let streamReadCount = 0;
      const chunks = [
        new TextEncoder().encode('event: response.created\ndata: {"id":"resp_123","status":"in_progress"}\n\n'),
        new TextEncoder().encode('event: response.output_text.delta\ndata: {"delta":"Hello"}\n\n'),
        new TextEncoder().encode('event: response.completed\ndata: {"response":{"status":"completed"}}\n\n'),
      ];

      const mockStream = new ReadableStream({
        pull(controller) {
          if (streamReadCount < chunks.length) {
            controller.enqueue(chunks[streamReadCount++]);
          } else {
            controller.close();
          }
        },
      });

      const mockResponse = new Response(mockStream, { status: 200, statusText: "OK" });
      const peek = await executor._peekSseOverloaded(mockResponse);

      expect(peek.matched).toBeNull();
      expect(peek.replacementBody).toBeDefined();

      // Read through replacement stream and verify all chunks from beginning to end are received
      const reader = peek.replacementBody.getReader();
      const decoded = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        decoded.push(new TextDecoder().decode(value));
      }
      const fullText = decoded.join("");
      expect(fullText).toContain("response.created");
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
  });

  describe("openaiToOpenAIResponsesRequest tool and instructions handling", () => {
    it("merges multiple system messages into instructions without dropping", () => {
      const body = {
        messages: [
          { role: "system", content: "Instruction part 1" },
          { role: "developer", content: "Instruction part 2" },
          { role: "user", content: "Hello" },
        ],
      };

      const result = openaiToOpenAIResponsesRequest("gpt-5.6-sol", body, true, null);
      expect(result.instructions).toBe("Instruction part 1\n\nInstruction part 2");
      expect(result.input).toHaveLength(1);
      expect(result.input[0].role).toBe("user");
    });

    it("passes through tool_choice and normalizes function call arguments", () => {
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

      // Verify function_call_output in input
      const funcOutput = result.input.find((i) => i.type === "function_call_output");
      expect(funcOutput).toBeDefined();
      expect(funcOutput.output).toBe("total 0");
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
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{\\"cmd\\":\\"git status\\"}"}\n\n',
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
  });
});
