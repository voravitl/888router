import { NextResponse } from "next/server";
import { listAipassModels } from "open-sse/services/aipassBridge.js";
import { getExtCorsHeaders, handleExtOptions } from "@/lib/extCors.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const url = new URL(request.url);
  const force = url.searchParams.get("refresh") === "1";
  const models = await listAipassModels({ force });
  return NextResponse.json({ models }, { headers: getExtCorsHeaders(request) });
}

export async function OPTIONS(request) {
  return handleExtOptions(request);
}
