import { NextResponse } from "next/server";
import {
  getClientCount,
  getAipassQuota,
  listAipassModels,
  getBridgeDefaultModel,
} from "open-sse/services/aipassBridge.js";
import { getExtCorsHeaders, handleExtOptions } from "@/lib/extCors.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const extensions = getClientCount();
  const credits = extensions > 0 ? await getAipassQuota() : null;
  const models = await listAipassModels();

  return NextResponse.json(
    {
      service: "888router-aipass-bridge",
      status: "ok",
      extensions,
      credits,
      models,
      defaultModel: getBridgeDefaultModel(),
    },
    { headers: getExtCorsHeaders(request) }
  );
}

export async function OPTIONS(request) {
  return handleExtOptions(request);
}
