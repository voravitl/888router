import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Serve a skill's SKILL.md from the local skills dir so dashboard links point
// at THIS gateway (self-hosted), not at GitHub raw. AI agents fetch the copy
// link and get the markdown back directly from 9router.
function resolveSkillsDir() {
  if (process.env.SKILLS_DIR && fs.existsSync(process.env.SKILLS_DIR)) {
    return process.env.SKILLS_DIR;
  }
  const candidates = [
    path.join(process.cwd(), "skills"),
    path.join(process.cwd(), "../../../skills"),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return path.join(process.cwd(), "skills");
}

export async function GET(request, { params }) {
  const { id } = await params;
  // Guard: id must be a plain directory name (no traversal) — it becomes part
  // of a filesystem path below.
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return new NextResponse("Invalid skill id", { status: 400 });
  }
  const dir = resolveSkillsDir();
  const filePath = path.join(dir, id, "SKILL.md");
  if (!fs.existsSync(filePath)) {
    return new NextResponse("Skill not found", { status: 404 });
  }
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return new NextResponse(content, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[Skills] read failed:", error.message);
    return new NextResponse("Failed to read skill", { status: 500 });
  }
}
