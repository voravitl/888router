import { computeFreeModelTotals } from "../../config/freeModelCatalog.js";
import { AUTO_COMBO_TEMPLATES } from "../autoCombo/builtinCatalog.js";
import { PROVIDERS } from "../../config/providers.js";

export const MCP_SERVER_INFO = {
  name: "888router-mcp",
  version: "0.15.45",
  protocolVersion: "2024-11-05",
};

export const MCP_TOOLS = [
  {
    name: "list_models",
    description: "List all usable models, active providers, and zero-config auto-combos",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Optional filter (coding, reasoning, vision, free)",
        },
      },
    },
  },
  {
    name: "check_free_quotas",
    description: "Check documented free-tier token budgets and uncapped zero-cost providers",
    inputSchema: {
      type: "object",
      properties: {
        excludeTosAvoid: {
          type: "boolean",
          description: "Exclude providers with intrusive terms of service",
        },
      },
    },
  },
  {
    name: "get_auto_combos",
    description: "Get list of available zero-setup auto routing templates",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

/**
 * Handle incoming MCP JSON-RPC requests
 * @param {object} rpcReq - JSON-RPC 2.0 request payload
 * @returns {Promise<object>} JSON-RPC 2.0 response
 */
export async function handleMcpRpcRequest(rpcReq) {
  const { id, method, params } = rpcReq || {};

  if (!method) {
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };
  }

  // 1. Initialize
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: MCP_SERVER_INFO.protocolVersion,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: MCP_SERVER_INFO,
      },
    };
  }

  // 2. Notifications (initialized)
  if (method === "notifications/initialized") {
    return { jsonrpc: "2.0", id: null, result: {} };
  }

  // 3. Tools List
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: MCP_TOOLS,
      },
    };
  }

  // 4. Tools Call
  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments || {};

    if (toolName === "list_models") {
      const allModels = [];
      for (const [providerId, p] of Object.entries(PROVIDERS)) {
        if (p?.models) {
          for (const m of p.models) {
            const mId = typeof m === "string" ? m : m?.id;
            allModels.push(`${providerId}/${mId}`);
          }
        }
      }
      for (const t of AUTO_COMBO_TEMPLATES) {
        allModels.push(t.name);
      }
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: allModels.length, models: allModels }, null, 2),
            },
          ],
        },
      };
    }

    if (toolName === "check_free_quotas") {
      const totals = computeFreeModelTotals({ excludeTosAvoid: args.excludeTosAvoid });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(totals, null, 2),
            },
          ],
        },
      };
    }

    if (toolName === "get_auto_combos") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(AUTO_COMBO_TEMPLATES, null, 2),
            },
          ],
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Tool not found: ${toolName}` },
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}
