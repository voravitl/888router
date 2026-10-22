#!/usr/bin/env node
// Require a version bump when a change touches shipped code.
//
// The gateway reports its version from package.json (/api/version). A merged
// fix that does not bump it ships an image whose CODE moved but whose VERSION
// did not — undeployable and unverifiable: you cannot tell which build is
// running, and a rollback to "the previous version" is ambiguous. That is
// lesson #503, merged at 0.15.141 with new code.
//
// Usage:
//   node scripts/check-release-bump.mjs [--base <sha>] [--head <sha>]
//
//   --base  the commit the change is measured against (default: the merge base
//           of origin/master and HEAD)
//   --head  the commit holding the change (default: HEAD)
//
// Exit 0 = ok or skipped, 1 = a bump is missing (with the reason).
//
// What needs a bump: anything that ships in the image. What does not: docs,
// tests, CI config, repo maintenance scripts.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Paths whose changes never reach the running image.
export const IGNORED_PREFIXES = [
  "tests/", // test-only
  "docs/",
  "gitbook/",
  "graphify-out/",
  ".github/", // CI config
  "k8s/", // not deployed (issue #501)
  "scripts/", // repo maintenance, not copied into the runner
];

// Markdown is documentation — except under skills/, which the gateway SERVES
// to agents (/api/skills/raw/<id>) and which therefore ships.
export function isRuntimePath(file) {
  const p = file.replace(/\\/g, "/");
  if (IGNORED_PREFIXES.some((prefix) => p.startsWith(prefix))) return false;
  if (p.startsWith("skills/")) return true;
  if (p.endsWith(".md")) return false;
  return true;
}

// The version at the top of the changelog: "# v0.15.184 (2026-10-22)".
export function parseChangelogTopVersion(text) {
  const m = String(text).match(/^#\s+v?(\d+\.\d+\.\d+)/m);
  return m ? m[1] : null;
}

export function compareSemver(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const da = Number.isFinite(pa[i]) ? pa[i] : 0;
    const db = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (da !== db) return da - db;
  }
  return 0;
}

// The whole rule, as a pure function, so it can be tested without git.
export function evaluateReleaseBump({
  changedFiles,
  baseVersion,
  headVersion,
  lockVersion,
  changelogTopVersion,
}) {
  const problems = [];
  const notes = [];
  const runtime = changedFiles.filter(isRuntimePath);
  const ignored = changedFiles.filter((f) => !isRuntimePath(f));

  if (runtime.length === 0) {
    notes.push(
      `no shipped code changed (${changedFiles.length} file(s) ignored: docs, tests, CI config)`,
    );
    return { ok: true, problems, notes, runtime, ignored };
  }

  if (!headVersion) {
    problems.push("package.json has no version");
  } else {
    if (baseVersion && headVersion === baseVersion) {
      problems.push(
        `package.json version is still ${headVersion} — a shipped-code change must bump it (npm version patch)`,
      );
    } else if (baseVersion && compareSemver(headVersion, baseVersion) < 0) {
      problems.push(
        `package.json version went backwards: ${baseVersion} -> ${headVersion} — rebase on master and bump above ${baseVersion}`,
      );
    }
    if (lockVersion && lockVersion !== headVersion) {
      problems.push(
        `package-lock.json version is ${lockVersion}, package.json is ${headVersion} — regenerate the lock (npm install), do not hand-edit`,
      );
    }
    if (!changelogTopVersion) {
      problems.push("CHANGELOG.md has no version heading");
    } else if (changelogTopVersion !== headVersion) {
      problems.push(
        `CHANGELOG.md's top entry is v${changelogTopVersion}, package.json is ${headVersion} — the changelog must lead with the released version`,
      );
    }
  }

  return { ok: problems.length === 0, problems, notes, runtime, ignored };
}

// ---------------------------------------------------------------- git helpers

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1 << 26,
    }).trim();
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

function readJsonAt(ref, file) {
  const raw = git(["show", `${ref}:${file}`], { allowFail: true });
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = { base: null, head: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") out.base = argv[++i];
    else if (argv[i] === "--head") out.head = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(path.join(REPO_ROOT, ".git"))) {
    console.log("SKIP: not a git checkout — nothing to compare");
    return 0;
  }

  const head = args.head || "HEAD";
  // The merge base is the right reference: it is the state the branch forked
  // from, so a version that merely matches master's tip is not "unchanged" —
  // it is a release that predates the branch point.
  let base = args.base;
  let usedMergeBase = false;
  if (!base) {
    base = git(["merge-base", "origin/master", head], { allowFail: true });
    usedMergeBase = true;
  }
  if (!base) {
    console.log(
      "SKIP: could not determine the base commit — pass --base <sha> explicitly",
    );
    return 0;
  }

  // Three-dot diff (changes on head since the fork point). If the merge base
  // is not in this checkout, fall back to the tree difference and say so.
  let changedFiles = git(["diff", "--name-only", `${base}...${head}`], {
    allowFail: true,
  });
  let diffMode = "three-dot (merge base)";
  if (changedFiles === null) {
    changedFiles = git(["diff", "--name-only", base, head], { allowFail: true });
    diffMode = "two-dot (merge base unavailable in this checkout)";
  }
  if (changedFiles === null) {
    console.error(
      `::error::cannot diff ${base}..${head} — those commits are not in this checkout (fetch them, e.g. git fetch --depth=100 origin <sha>)`,
    );
    return 1;
  }
  const files = changedFiles.split("\n").filter(Boolean);

  const basePkg = readJsonAt(base, "package.json");
  const headPkg = readJsonAt(head, "package.json");
  const headLock = readJsonAt(head, "package-lock.json");
  const changelog = git(["show", `${head}:CHANGELOG.md`], { allowFail: true });
  const changelogTopVersion = changelog
    ? parseChangelogTopVersion(changelog)
    : null;

  const result = evaluateReleaseBump({
    changedFiles: files,
    baseVersion: basePkg?.version ?? null,
    headVersion: headPkg?.version ?? null,
    lockVersion: headLock?.version ?? null,
    changelogTopVersion,
  });

  console.log(`base  ${base}${usedMergeBase ? " (merge base with origin/master)" : ""}`);
  console.log(`head  ${head}`);
  console.log(`diff  ${files.length} file(s), ${diffMode}`);
  if (result.runtime.length) {
    console.log(`shipped code changed: ${result.runtime.join(", ")}`);
  }

  if (result.ok) {
    for (const n of result.notes) console.log(`OK: ${n}`);
    console.log("OK: release bump requirements satisfied");
    return 0;
  }

  for (const p of result.problems) console.error(`::error::${p}`);
  console.error(
    "::error::a change to shipped code must bump the version in the SAME branch (npm version patch, then CHANGELOG entry, then the bump commit last)",
  );
  return 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
