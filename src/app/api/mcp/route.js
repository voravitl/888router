import { NextResponse } from "next/server";
import { handleMcpRpcRequest } from "open-sse/services/mcp/server.js";
import { withLogging } from "@/lib/apiLogger";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

async function POSTHandler(request) {
  try {
    const body = await request.json();
    const response = await handleMcpRpcRequest(body);
    return NextResponse.json(response, {
      status: 200,
      headers: CORS_HEADERS,
    });
  } catch (err) {
    console.error("[API] /api/mcp error:", err);
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400, headers: CORS_HEADERS }
    );
  }
}

export const POST = withLogging(POSTHandler, "POST /api/mcp");
