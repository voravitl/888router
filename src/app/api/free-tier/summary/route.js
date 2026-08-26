import { NextResponse } from "next/server";
import { computeFreeModelTotals, FREE_CATALOG_CURATED_AT } from "open-sse/config/freeModelCatalog.js";
import { withLogging } from "@/lib/apiLogger";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

async function GETHandler(request) {
  try {
    const { searchParams } = new URL(request.url);
    const excludeTosAvoid = searchParams.get("excludeTosAvoid") === "1" || searchParams.get("excludeTosAvoid") === "true";

    const totals = computeFreeModelTotals({ excludeTosAvoid });

    const body = {
      ...totals,
      catalogUpdatedAt: FREE_CATALOG_CURATED_AT,
      catalogSource: "baseline",
    };

    return NextResponse.json(body, {
      status: 200,
      headers: CORS_HEADERS,
    });
  } catch (error) {
    console.error("[API] /api/free-tier/summary failed:", error);
    return NextResponse.json({ error: "Failed to compute free tier summary" }, { status: 500 });
  }
}

export const GET = withLogging(GETHandler, "GET /api/free-tier/summary");
