import { NextResponse } from "next/server";
import fs from "fs";
import { resolveSkillFile } from "@/shared/skillsDir";
import { resolveOrigin, absolutizeSkillRefs } from "@/shared/skillRefs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Serve a skill's SKILL.md from the local skills dir so dashboard links point
// at THIS gateway (self-hosted), not at GitHub raw. AI agents fetch the copy
// link and get the markdown back directly from 9router.
//
// Cross-skill references are stored RELATIVE in the repo (/api/skills/raw/<id>)
// so the source is portable. At serve time we rewrite them to ABSOLUTE URLs
// based on a trusted origin (NINEROUTER_PUBLIC_URL if set, else request URL) —
// agents following a link in one skill can fetch the next skill without
// guessing the host.
export async function GET(request, { params }) {
  const { id } = await params;
  const filePath = resolveSkillFile(id); // traversal + symlink-escape guarded
  if (!filePath || !fs.existsSync(filePath)) {
    return new NextResponse("Skill not found", { status: 404 });
  }
  try {
    const origin = resolveOrigin(request.url);
    const content = absolutizeSkillRefs(
      fs.readFileSync(filePath, "utf8"),
      origin
    );
    return new NextResponse(content, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[Skills] read failed:", error.message);
    return new NextResponse("Failed to read skill", { status: 500 });
  }
}
