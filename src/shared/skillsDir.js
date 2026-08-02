// Shared skills-dir resolution for the skills catalog + raw endpoints.
import fs from "fs";
import path from "path";

export function resolveSkillsDir() {
  // Explicit env override wins (set in image/entrypoint) — no path guessing.
  if (process.env.SKILLS_DIR && fs.existsSync(process.env.SKILLS_DIR)) {
    return process.env.SKILLS_DIR;
  }
  // In Next standalone, cwd is the standalone dir; the skills dir ships next
  // to it. Fall back to repo root for dev.
  const candidates = [
    path.join(process.cwd(), "skills"),
    path.join(process.cwd(), "../../../skills"),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return path.join(process.cwd(), "skills");
}

// Resolve <dir>/<id>/SKILL.md and ensure the realpath stays inside dir.
// path.resolve does NOT follow symlinks, but readFileSync does — so we realpath
// BOTH sides and prefix-check the real path, which blocks a symlinked
// SKILL.md escaping to /etc/passwd etc.
export function resolveSkillFile(id) {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  const dir = fs.realpathSync(path.resolve(resolveSkillsDir()));
  const candidate = path.join(dir, id, "SKILL.md");
  if (!fs.existsSync(candidate)) return null;
  const filePath = fs.realpathSync(candidate);
  if (!filePath.startsWith(dir + path.sep)) return null;
  return filePath;
}
