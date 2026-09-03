import { NextResponse } from "next/server";
import { getAipassQuota } from "open-sse/services/aipassBridge.js";
import { getExtCorsHeaders, handleExtOptions } from "@/lib/extCors.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const quota = await getAipassQuota();
  if (!quota) {
    return NextResponse.json(
      { error: "Extension not connected or quota unavailable" },
      { status: 503, headers: getExtCorsHeaders(request) }
    );
  }
  return NextResponse.json(quota, { headers: getExtCorsHeaders(request) });
}

export async function OPTIONS(request) {
  return handleExtOptions(request);
}
