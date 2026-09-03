import { NextResponse } from "next/server";
import { handleExtLoader } from "open-sse/services/aipassBridge.js";
import { getExtCorsHeaders, handleExtOptions } from "@/lib/extCors.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const body = await request.json();
    const ok = handleExtLoader(body);
    return NextResponse.json({ ok }, { headers: getExtCorsHeaders(request) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 400, headers: getExtCorsHeaders(request) });
  }
}

export async function OPTIONS(request) {
  return handleExtOptions(request);
}
