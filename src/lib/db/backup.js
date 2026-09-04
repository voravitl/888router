import fs from "node:fs";
import path from "node:path";
import { BACKUPS_DIR, ensureDirs } from "./paths.js";
import { timestampSlug, getAppVersion } from "./version.js";

// Retention: keep at most KEEP_BACKUPS backup dirs, AND keep the total
// size under KEEP_BACKUPS_TOTAL_BYTES. The DB backup is a full copy of
// data.sqlite, so a multi-GB DB multiplies fast (5 × 6.3GB = 32GB observed).
const KEEP_BACKUPS = Number(process.env.KEEP_BACKUPS) || 2;
const KEEP_BACKUPS_TOTAL_BYTES = Number(process.env.KEEP_BACKUPS_TOTAL_BYTES) || 3 * 1024 * 1024 * 1024;

export function makeBackupDir(label) {
  ensureDirs();
  const ver = getAppVersion();
  const slug = `${label}-${ver}-${timestampSlug()}`;
  const dir = path.join(BACKUPS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function backupFile(srcPath, destDir, destName = null) {
  if (!fs.existsSync(srcPath)) return null;
  const name = destName || path.basename(srcPath);
  const dest = path.join(destDir, name);
  fs.copyFileSync(srcPath, dest);
  return dest;
}

function dirSize(full) {
  let total = 0;
  const stack = [full];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else total += fs.statSync(p).size;
    }
  }
  return total;
}

export function pruneOldBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return;
  let entries;
  try {
    entries = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, full: path.join(BACKUPS_DIR, e.name), mtime: fs.statSync(path.join(BACKUPS_DIR, e.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return; // fail-open: prune must never break startup
  }

  for (const old of entries.slice(KEEP_BACKUPS)) {
    try { fs.rmSync(old.full, { recursive: true, force: true }); } catch {}
  }

  // Size budget: after the count cap, still trim oldest-first until the
  // remaining backups fit under KEEP_BACKUPS_TOTAL_BYTES. The newest is always kept.
  const kept = entries.slice(0, KEEP_BACKUPS);
  let total = 0;
  const sizes = new Map();
  for (const e of kept) {
    try { sizes.set(e.full, dirSize(e.full)); } catch { sizes.set(e.full, 0); }
  }
  for (const e of kept) total += sizes.get(e.full) || 0;
  for (const e of kept.slice().reverse()) {
    if (total <= KEEP_BACKUPS_TOTAL_BYTES) break;
    if (e === kept[0]) break; // never delete the newest
    try { fs.rmSync(e.full, { recursive: true, force: true }); } catch { continue; }
    total -= sizes.get(e.full) || 0;
  }
}
