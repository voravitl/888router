import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Scan the repo's ./skills/<id>/SKILL.md directory at request time so the
// dashboard always reflects the skills actually shipped in the image — no
// hardcoded catalog list to keep in sync.
const REPO = "decolua/9router";
const BRANCH = "master";
const SKILL_PATH = "skills";

function resolveSkillsDir() {
  // In Next standalone, cwd is the standalone dir; the skills dir ships next
  // to it. Fall back to repo root for dev.
  const candidates = [
    path.join(process.cwd(), "skills"),
    path.join(process.cwd(), "../../../skills"),
    path.join(__dirname, "../../../../../../skills"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return path.join(process.cwd(), "skills");
}

// Parse YAML-ish frontmatter minimally: name:, description:, and a one-line
// endpoint: if present. Full YAML is overkill for these small SKILL.md files.
function parseFrontmatter(content) {
  const meta = { name: null, description: null, endpoint: null, isEntry: false };
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return meta;
  for (const line of m[1].split("\n")) {
    const k = line.match(/^(\w+):\s*(.*)$/);
    if (!k) continue;
    const val = k[2].trim();
    if (k[1] === "name") meta.name = val;
    else if (k[1] === "description") meta.description = val.replace(/^["']|["']$/g, "");
    else if (k[1] === "endpoint") meta.endpoint = val;
  }
  meta.isEntry = meta.name === "9Router (Entry)" || meta.name === "9router";
  return meta;
}

export async function GET() {
  try {
    const dir = resolveSkillsDir();
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory());

    const skills = [];
    for (const entry of entries) {
      const skillFile = path.join(dir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      let content = "";
      try { content = fs.readFileSync(skillFile, "utf8"); } catch { continue; }
      const meta = parseFrontmatter(content);
      const icon = iconForSkill(entry.name);
      skills.push({
        id: entry.name,
        name: meta.name || entry.name,
        description: meta.description || "",
        endpoint: meta.endpoint || null,
        icon,
        isEntry: meta.isEntry,
      });
    }

    // Entry skill first, then alphabetical.
    skills.sort((a, b) => (b.isEntry ? 1 : 0) - (a.isEntry ? 1 : 0) || a.name.localeCompare(b.name));

    return NextResponse.json({
      skills,
      repoUrl: `https://github.com/${REPO}`,
      rawBase: `https://raw.githubusercontent.com/${REPO}/refs/heads/${BRANCH}/${SKILL_PATH}`,
      blobBase: `https://github.com/${REPO}/blob/${BRANCH}/${SKILL_PATH}`,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[Skills] error scanning skills dir:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

function iconForSkill(id) {
  const map = {
    "9router": "hub",
    "9router-chat": "chat",
    "9router-image": "image",
    "9router-tts": "record_voice_over",
    "9router-stt": "mic",
    "9router-embeddings": "scatter_plot",
    "9router-web-search": "search",
    "9router-web-fetch": "language",
    "searxng": "search",
  };
  return map[id] || "extension";
}
