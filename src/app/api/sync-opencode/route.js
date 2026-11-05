import { NextResponse } from "next/server";
import { execSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = execSync("node scripts/sync-opencode-catalog.mjs", {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30000,
    });
    return NextResponse.json({ success: true, output: result });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error.message, output: error.stdout },
      { status: 500 }
    );
  }
}
