import { describe, it, expect } from "vitest";
import { handleMcpRpcRequest, MCP_SERVER_INFO, MCP_TOOLS } from "../../open-sse/services/mcp/server.js";

describe("Embedded MCP Server Protocol Engine", () => {
  it("handles initialize handshake", async () => {
    const res = await handleMcpRpcRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });

    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(1);
    expect(res.result.serverInfo.name).toBe("888router-mcp");
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it("lists supported MCP tools", async () => {
    const res = await handleMcpRpcRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    expect(res.result.tools).toHaveLength(MCP_TOOLS.length);
    const toolNames = res.result.tools.map((t) => t.name);
    expect(toolNames).toContain("list_models");
    expect(toolNames).toContain("check_free_quotas");
    expect(toolNames).toContain("get_auto_combos");
  });

  it("executes tools/call for check_free_quotas", async () => {
    const res = await handleMcpRpcRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "check_free_quotas",
        arguments: { excludeTosAvoid: true },
      },
    });

    expect(res.result.content[0].type).toBe("text");
    const parsed = JSON.parse(res.result.content[0].text);
    expect(parsed.steadyRecurringTokens).toBeGreaterThan(1_000_000_000);
  });
});
