import { NextResponse } from "next/server";
import { getBridgeDefaultModel, setBridgeDefaultModel } from "open-sse/services/aipassBridge.js";
import { getExtCorsHeaders, handleExtOptions } from "@/lib/extCors.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  return NextResponse.json({ defaultModel: getBridgeDefaultModel() }, { headers: getExtCorsHeaders(request) });
}

export async function POST(request) {
  try {
    const body = await request.json();
    if (body?.defaultModel && typeof body.defaultModel === "string") {
      setBridgeDefaultModel(body.defaultModel);
    }
    return NextResponse.json({ ok: true, defaultModel: getBridgeDefaultModel() }, { headers: getExtCorsHeaders(request) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 400, headers: getExtCorsHeaders(request) });
  }
}

export async function OPTIONS(request) {
  return handleExtOptions(request);
}
