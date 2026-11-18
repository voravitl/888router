import { NextResponse } from "next/server";
import { execSync } from "child_process";
import { GET as syncProviderModels } from "@/app/api/providers/[id]/models/route.js";

export const dynamic = "force-dynamic";

export async function POST() {
  let scriptOutput = "";
  let scriptWarning;

  try {
    scriptOutput = execSync("node scripts/sync-opencode-catalog.mjs", {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30000,
    });
  } catch (error) {
    // In read-only container filesystems, static registry writes fail; keep going
    // so live provider sync still updates SQLite syncedModels & capabilities.
    scriptWarning = error?.message || "Failed to execute sync-opencode-catalog.mjs";
    scriptOutput = error?.stdout || "";
  }

  const providers = ["opencode", "opencode-go"];
  const results = await Promise.all(
    providers.map(async (providerId) => {
      try {
        const req = new Request(`http://localhost/api/providers/${providerId}/models`);
        const res = await syncProviderModels(req, { params: Promise.resolve({ id: providerId }) });
        const status = res?.status ?? 200;
        const data = await res.json().catch(() => ({}));
        if (status >= 400 || data?.error) {
          return {
            provider: providerId,
            ok: false,
            modelCount: 0,
            error: data?.error || `HTTP ${status}`,
          };
        }
        const models = Array.isArray(data?.models) ? data.models : [];
        return {
          provider: providerId,
          ok: true,
          modelCount: models.length,
          ...(data?.warning ? { warning: data.warning } : {}),
        };
      } catch (err) {
        return {
          provider: providerId,
          ok: false,
          modelCount: 0,
          error: err?.message || "Sync failed",
        };
      }
    }),
  );

  const anyLiveOk = results.some((r) => r.ok);
  const totalModels = results.reduce((sum, r) => sum + (r.modelCount || 0), 0);

  if (!anyLiveOk && scriptWarning) {
    return NextResponse.json(
      {
        success: false,
        error: scriptWarning,
        output: scriptOutput,
        results,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    success: true,
    output: scriptOutput || `Found ${totalModels} models across ${providers.join(", ")}`,
    ...(scriptWarning ? { scriptWarning } : {}),
    results,
    totalModels,
  });
}
