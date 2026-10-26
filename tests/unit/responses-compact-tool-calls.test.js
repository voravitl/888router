import { describe, it, expect } from "vitest";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";

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

function aggregateToolCalls(chunks) {
  const tools = [];
  for (const c of chunks) {
    const tcList = c?.choices?.[0]?.delta?.tool_calls;
    if (!tcList) continue;
    for (const tc of tcList) {
      const idx = tc.index ?? 0;
      if (!tools[idx]) {
        tools[idx] = { id: tc.id || "", name: tc.function?.name || "", arguments: "" };
      }
      if (tc.id) tools[idx].id = tc.id;
      if (tc.function?.name) tools[idx].name = tc.function.name;
      if (tc.function?.arguments) tools[idx].arguments += tc.function.arguments;
    }
  }
  return tools;
}

const item = (id, args, type = "function_call") => ({
  id: `item_${id}`, call_id: `call_${id}`, name: `tool_${id}`, type,
  ...(type === "custom_tool_call" ? { input: args } : { arguments: args })
});
const added = (id, output_index = 0, type) => ({ type: "response.output_item.added", output_index, item: item(id, "", type) });
const done = (id, args, output_index = 0, type) => ({ type: "response.output_item.done", output_index, item: item(id, args, type) });
const delta = (id, value) => ({ type: "response.function_call_arguments.delta", item_id: `item_${id}`, delta: value });
const argsDone = (id, args) => ({ type: "response.function_call_arguments.done", item_id: `item_${id}`, arguments: args });

 describe("terminal argument boundaries", () => {
  it("routes interleaved calls with sparse output indices and reversed done order", () => {
    const chunks = runEvents([added("a", 2), added("b", 7), delta("a", '{"x":'), delta("b", '{"y":'),
      argsDone("b", '{"y":2}'), done("b", '{"y":2}', 7), argsDone("a", '{"x":1}'), done("a", '{"x":1}', 2)]);
    expect(aggregateToolCalls(chunks)).toEqual([
      { id: "call_a", name: "tool_a", arguments: '{"x":1}' },
      { id: "call_b", name: "tool_b", arguments: '{"y":2}' }
    ]);
    expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });

  it.each(["{}", "", undefined, null])("preserves item-only terminal value %s without inventing arguments", args => {
    const chunks = runEvents([done("a", args)]);
    expect(aggregateToolCalls(chunks)[0]).toEqual({ id: "call_a", name: "tool_a", arguments: args ?? "" });
    expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });

  it("recovers multiple completed-only calls in a single chunk with usage and one finish", () => {
    const event = { type: "response.completed", response: { output: [
      { type: "message", content: [] }, item("a", "{}"), item("b", "raw\ninput", "custom_tool_call")
    ], usage: { input_tokens: 2, output_tokens: 3 }
    }
    };
    const state = {};
    const chunk = openaiResponsesToOpenAIResponse(event, state);
    expect(Array.isArray(chunk)).toBe(false);
    expect(aggregateToolCalls([chunk])).toEqual([
      { id: "call_a", name: "tool_a", arguments: "{}" },
      { id: "call_b", name: "tool_b", arguments: "raw\ninput" }
    ]);
    expect(chunk.choices[0].finish_reason).toBe("tool_calls");
    expect(chunk.usage.total_tokens).toBe(5);
    expect(openaiResponsesToOpenAIResponse(event, state)).toBeNull();
    expect(openaiResponsesToOpenAIResponse(null, state)).toBeNull();
  });

  it("uses call_id and explicit output_index fallbacks without current-call cross-talk", () => {
    const chunks = runEvents([added("a", 2), added("b", 7),
      { type: "response.function_call_arguments.delta", call_id: "call_a", delta: "A" },
      { type: "response.function_call_arguments.delta", output_index: 7, delta: "B" },
      { type: "response.function_call_arguments.delta", delta: "unresolvable" }]);
    expect(aggregateToolCalls(chunks).map(t => t.arguments)).toEqual(["A", "B"]);
  });

  it.each(["response.custom_tool_call_input.done", "response.output_item.done"])("preserves custom raw input via %s", terminal => {
    const chunks = runEvents([added("a", 0, "custom_tool_call"),
      { type: "response.custom_tool_call_input.delta", item_id: "item_a", delta: "line 1\n" },
      terminal === "response.output_item.done" ? done("a", "line 1\nline 2", 0, "custom_tool_call")
        : { type: terminal, item_id: "item_a", input: "line 1\nline 2" },
      done("a", "line 1\nline 2", 0, "custom_tool_call")]);
    expect(aggregateToolCalls(chunks)[0].arguments).toBe("line 1\nline 2");
  });

  it("does not repeat full arguments across duplicate finals or completion fallback", () => {
    const chunks = runEvents([added("a"), delta("a", '{"x":'), delta("a", '1}'), argsDone("a", '{"x":1}'),
      argsDone("a", '{"x":1}'), done("a", '{"x":1}'), done("a", '{"x":1}'),
      { type: "response.done", response: { output: [item("a", '{"x":1}')] }
      }]);
    expect(aggregateToolCalls(chunks)[0].arguments).toBe('{"x":1}');
    expect(chunks.filter(c => c.choices[0].finish_reason)).toHaveLength(1);
  });

  it("keeps streamed prefix on conflicting final and does not downgrade accepted final", () => {
    const chunks = runEvents([added("a"), delta("a", "prefix"), argsDone("a", "different"), done("a", "prefix suffix")]);
    expect(aggregateToolCalls(chunks)[0].arguments).toBe("prefix");
  });

  it("missing terminal value still permits a later item fallback", () => {
    const chunks = runEvents([added("a"), argsDone("a", undefined), done("a", "{}")]);
    expect(aggregateToolCalls(chunks)[0].arguments).toBe("{}");
  });

  it("empty deltas and repeated starts do not duplicate identity or arguments", () => {
    const chunks = runEvents([added("a"), added("a"), delta("a", ""), argsDone("a", "{}"), delta("a", "late")]);
    expect(aggregateToolCalls(chunks)[0].arguments).toBe("{}");
    expect(chunks.flatMap(c => c.choices[0].delta.tool_calls || []).filter(t => t.id)).toHaveLength(1);
  });
});

describe("compact OpenAI Responses tool call streams (done without deltas)", () => {
  it("preserves arguments from response.function_call_arguments.done when no deltas sent", () => {
    const events = [
      { type: "response.created", response: { id: "resp_1" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "item_1",
          type: "function_call",
          call_id: "call_abc123",
          name: "skill_view",
          arguments: ""
        }
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: "item_1",
        call_id: "call_abc123",
        arguments: '{"name":"omh-help"}'
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "item_1",
          type: "function_call",
          call_id: "call_abc123",
          name: "skill_view",
          arguments: '{"name":"omh-help"}'
        }
      },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }
    ];

    const chunks = runEvents(events);
    const tools = aggregateToolCalls(chunks);

    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("skill_view");
    expect(tools[0].arguments).toBe('{"name":"omh-help"}');
  });

  it("handles parallel tool calls without deltas correctly", () => {
    const events = [
      { type: "response.created", response: { id: "resp_2" } },
      // First call
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "item_1",
          type: "function_call",
          call_id: "call_1",
          name: "skill_view",
          arguments: ""
        }
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: "item_1",
        call_id: "call_1",
        arguments: '{"name":"hermes-agent"}'
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "item_1",
          type: "function_call",
          call_id: "call_1",
          name: "skill_view",
          arguments: '{"name":"hermes-agent"}'
        }
      },
      // Second call
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          id: "item_2",
          type: "function_call",
          call_id: "call_2",
          name: "read_file",
          arguments: ""
        }
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 1,
        item_id: "item_2",
        call_id: "call_2",
        arguments: '{"path":"package.json"}'
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: "item_2",
          type: "function_call",
          call_id: "call_2",
          name: "read_file",
          arguments: '{"path":"package.json"}'
        }
      },
      { type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } }
    ];

    const chunks = runEvents(events);
    const tools = aggregateToolCalls(chunks);

    expect(tools.length).toBe(2);
    expect(tools[0].name).toBe("skill_view");
    expect(tools[0].arguments).toBe('{"name":"hermes-agent"}');
    expect(tools[1].name).toBe("read_file");
    expect(tools[1].arguments).toBe('{"path":"package.json"}');
  });

  it("does NOT double-emit when deltas were already sent", () => {
    const events = [
      { type: "response.created", response: { id: "resp_3" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "item_1",
          type: "function_call",
          call_id: "call_3",
          name: "terminal",
          arguments: ""
        }
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "item_1",
        call_id: "call_3",
        delta: '{"command":"ls"}'
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: "item_1",
        call_id: "call_3",
        arguments: '{"command":"ls"}'
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "item_1",
          type: "function_call",
          call_id: "call_3",
          name: "terminal",
          arguments: '{"command":"ls"}'
        }
      },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }
    ];

    const chunks = runEvents(events);
    const tools = aggregateToolCalls(chunks);

    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("terminal");
    expect(tools[0].arguments).toBe('{"command":"ls"}');
  });
});
