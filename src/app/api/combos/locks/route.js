import { NextResponse } from "next/server";
import { listComboLocks, unlockComboModel } from "open-sse/services/combo.js";

// Process-local combo locks (quota / 401 / head-timeout). GET lists, POST unlocks.
export async function GET() {
  return NextResponse.json({ locks: listComboLocks() });
}

export async function POST(request) {
  try {
    const { model, all } = await request.json();
    if (all === true) unlockComboModel();
    else if (typeof model === "string" && model) unlockComboModel(model);
    else return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
