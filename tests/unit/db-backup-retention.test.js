import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// backup.js resolves dirs at import time via paths.js → DATA_DIR, so point
// DATA_DIR at a temp dir BEFORE the first import of the module under test.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "db-backup-test-"));
process.env.DATA_DIR = tmpRoot;

const { pruneOldBackups } = await import("../../src/lib/db/backup.js");
const { BACKUPS_DIR } = await import("../../src/lib/db/paths.js");

// Directory mtimes cannot be backdated reliably on macOS/APFS (utimesSync on
// a dir leaves a bogus sentinel value), so fixtures create backups in
// chronological order oldest→newest and rely on natural mtime ordering —
// the same signal pruneOldBackups() sorts on in production.
let seq = 0;
function makeBackup(name, sizeBytes) {
  const dir = path.join(BACKUPS_DIR, `${String(seq++).padStart(4, "0")}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "data.sqlite"), Buffer.alloc(sizeBytes, 0));
  return dir;
}

function remaining() {
  return fs
    .readdirSync(BACKUPS_DIR)
    .map((n) => n.replace(/^\d{4}-/, ""))
    .sort();
}

async function tick() {
  await new Promise((r) => setTimeout(r, 25)); // ensure distinct dir mtimes
}

describe("pruneOldBackups", () => {
  beforeEach(() => {
    fs.rmSync(BACKUPS_DIR, { recursive: true, force: true });
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    seq = 0;
  });

  afterEach(() => {
    fs.rmSync(BACKUPS_DIR, { recursive: true, force: true });
  });

  it("keeps only the 2 newest backups when more exist", async () => {
    makeBackup("b-old1", 1000);
    await tick();
    makeBackup("b-old2", 1000);
    await tick();
    makeBackup("b-prev", 1000);
    await tick();
    makeBackup("b-new", 1000);

    pruneOldBackups();

    expect(remaining()).toEqual(["b-new", "b-prev"]);
  });

  it("never deletes the newest backup even when a backup alone exceeds the size cap", async () => {
    makeBackup("b-old", 50 * 1024 * 1024);
    await tick();
    makeBackup("b-prev", 50 * 1024 * 1024);
    await tick();
    makeBackup("b-newest", 50 * 1024 * 1024);

    pruneOldBackups();

    // count cap 2 → b-old gone; newest survives regardless of size
    expect(remaining()).toEqual(["b-newest", "b-prev"]);
  });

  it("size cap deletes the oldest kept backup when total exceeds budget", async () => {
    // Budget reads KEEP_BACKUPS_TOTAL_BYTES at import time, so exercise the
    // cap in a fresh node process with a tiny 40KB budget: 30KB + 25KB
    // exceeds it → the oldest kept backup must be trimmed, newest kept.
    const { execFileSync } = await import("node:child_process");
    const capRoot = path.join(tmpRoot, "cap-run");
    fs.rmSync(capRoot, { recursive: true, force: true });
    // src/lib/db/paths.js imports "@/lib/dataDir.js" — a jsconfig alias that
    // only vitest resolves. Map it for the subprocess via a loader shim.
    const loader = path.join(tmpRoot, "alias-loader.mjs");
    const srcRoot = JSON.stringify(path.resolve("src"));
    fs.writeFileSync(
      loader,
      `export async function resolve(specifier, context, next) {
         if (specifier.startsWith("@/")) {
           const url = ${srcRoot} + "/" + specifier.slice(2);
           return next(url, context);
         }
         return next(specifier, context);
       }`,
    );
    const script = `
      process.env.KEEP_BACKUPS_TOTAL_BYTES = "40960";
      process.env.DATA_DIR = ${JSON.stringify(capRoot)};
      const fs = await import("node:fs");
      const base = process.env.DATA_DIR + "/db/backups/";
      const names = ["b-oldest", "b-newest"];
      const sizes = [30 * 1024, 25 * 1024];
      for (let i = 0; i < names.length; i++) {
        const dir = base + "0" + i + "-" + names[i];
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(dir + "/data.sqlite", Buffer.alloc(sizes[i], 0));
        await new Promise((r) => setTimeout(r, 30));
      }
      const { pruneOldBackups } = await import(${JSON.stringify(path.resolve("src/lib/db/backup.js"))});
      pruneOldBackups();
      console.log(JSON.stringify(fs.readdirSync(base).map((n) => n.replace(/^\\d+-/, "")).sort()));
    `;
    const out = execFileSync(
      process.execPath,
      ["--import", `data:text/javascript,import { register } from 'node:module'; register(${JSON.stringify("file://" + loader)});`, "--input-type=module", "-e", script],
      { encoding: "utf8" },
    );
    expect(JSON.parse(out.trim())).toEqual(["b-newest"]);
  });

  it("is a no-op on an empty backups dir", () => {
    pruneOldBackups();
    expect(remaining()).toEqual([]);
  });

  it("fails open: a stray file next to backup dirs does not throw", () => {
    fs.writeFileSync(path.join(BACKUPS_DIR, "stray-file"), "x");
    makeBackup("b-new", 1000);
    expect(() => pruneOldBackups()).not.toThrow();
    expect(remaining()).toContain("b-new");
  });

  it("optimizeDbBeforeBackup prunes requestDetails and runs vacuum when free pages exceed threshold", async () => {
    const { optimizeDbBeforeBackup } = await import("../../src/lib/db/migrate.js");
    const runCalls = [];
    const execCalls = [];
    const mockAdapter = {
      get: (sql) => {
        if (sql.includes("settings")) return { data: JSON.stringify({ observabilityMaxRecords: 2000, observabilityRetentionDays: 7 }) };
        if (sql.includes("COUNT(*)")) return { c: 2500 };
        if (sql.includes("freelist_count")) return { freelist_count: 3000 };
        return null;
      },
      run: (sql, params) => { runCalls.push({ sql, params }); },
      exec: (sql) => { execCalls.push(sql); },
    };

    optimizeDbBeforeBackup(mockAdapter);

    expect(runCalls.some((c) => c.sql.includes("DELETE FROM requestDetails WHERE timestamp < ?"))).toBe(true);
    expect(runCalls.some((c) => c.sql.includes("ORDER BY timestamp ASC LIMIT ?"))).toBe(true);
    expect(execCalls).toContain("PRAGMA wal_checkpoint(TRUNCATE)");
  });

  it("optimizeDbBeforeBackup skips vacuum when freelist is below threshold", async () => {
    const { optimizeDbBeforeBackup } = await import("../../src/lib/db/migrate.js");
    const execCalls = [];
    const mockAdapter = {
      get: (sql) => {
        if (sql.includes("settings")) return { data: "{}" };
        if (sql.includes("COUNT(*)")) return { c: 100 };
        if (sql.includes("freelist_count")) return { freelist_count: 100 };
        return null;
      },
      run: () => {},
      exec: (sql) => { execCalls.push(sql); },
    };

    optimizeDbBeforeBackup(mockAdapter);
    expect(execCalls).toContain("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(execCalls).not.toContain("VACUUM");
  });
});