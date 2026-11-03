import { describe, it, expect, beforeEach } from "vitest";
import { compressMessages, formatRtkLog } from "../../open-sse/rtk/index.js";
import { gitDiff } from "../../open-sse/rtk/filters/gitDiff.js";
import { gitStatus } from "../../open-sse/rtk/filters/gitStatus.js";
import { grep } from "../../open-sse/rtk/filters/grep.js";
import { find } from "../../open-sse/rtk/filters/find.js";
import { dedupLog } from "../../open-sse/rtk/filters/dedupLog.js";
import { ls } from "../../open-sse/rtk/filters/ls.js";
import { tree } from "../../open-sse/rtk/filters/tree.js";
import { smartTruncate } from "../../open-sse/rtk/filters/smartTruncate.js";
import { readNumbered } from "../../open-sse/rtk/filters/readNumbered.js";
import { searchList } from "../../open-sse/rtk/filters/searchList.js";
import { gitLog } from "../../open-sse/rtk/filters/gitLog.js";
import { autoDetectFilter } from "../../open-sse/rtk/autodetect.js";
import { safeApply } from "../../open-sse/rtk/applyFilter.js";

function makeLongDiff() {
  const lines = ["diff --git a/foo.js b/foo.js", "index abc..def 100644", "--- a/foo.js", "+++ b/foo.js", "@@ -1,3 +1,200 @@"];
  for (let i = 0; i < 200; i++) lines.push(`+added line ${i} ${"x".repeat(20)}`);
  return lines.join("\n");
}

// Reformatted by git-status but every file name survives, so the fidelity gate
// accepts it. makeLongDiff() is refused instead: the diff cap drops hunk content.
function makeSafeStatus() {
  const files = Array.from({ length: 9 }, (_, i) => ` M src/file${i}.js`);
  // git's verbose preamble pads the payload past MIN_COMPRESS_SIZE (500 bytes)
  // without adding new file names for the fidelity gate to police.
  // No branch-tracking line ("origin/main" is path-like and git-status drops
  // it, which the fidelity gate would rightly refuse).
  const preamble = [
    "Changes not staged for commit:",
    '  (use "git add <file>..." to update what will be committed)',
    '  (use "git restore <file>..." to discard changes in working directory)',
    "  (commit or discard the untracked or modified content in submodules)",
    "  (use \"git add <file>...\" to mark resolution)",
    "  (use \"git checkout -- <file>...\" to discard changes)",
    "  (commit or discard the untracked or modified content in submodules)",
    "",
  ];
  return `${preamble.join("\n")}${files.join("\n")}\n`;
}

function makeGitStatus() {
  return [
    "On branch main",
    "Your branch is up to date with 'origin/main'.",
    "",
    "Changes not staged for commit:",
    "  (use \"git add <file>...\" to update what will be committed)",
    "\tmodified:   src/a.js",
    "\tmodified:   src/b.js",
    "\tnew file:   src/c.js",
    "\tdeleted:    src/old.js",
    "",
    "Untracked files:",
    "\tnotes.txt",
    "",
    "no changes added to commit"
  ].join("\n");
}

function makeGrepOutput() {
  const lines = [];
  for (let i = 1; i <= 40; i++) lines.push(`src/foo.js:${i}:const x${i} = "some value here with padding text padding text"`);
  for (let i = 1; i <= 10; i++) lines.push(`src/bar.js:${i}:const y${i} = "another value here with padding padding padding"`);
  return lines.join("\n");
}

function makeFindOutput() {
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(`./src/a/${i}.js`);
  for (let i = 0; i < 20; i++) lines.push(`./src/b/${i}.js`);
  for (let i = 0; i < 5; i++) lines.push(`./top${i}.md`);
  return lines.join("\n");
}

function makeGitLogOneline() {
  return [
    "abc1234 Add auth middleware",
    "def5678 Fix token refresh race",
    "fedcba9 Update docs"
  ].join("\n");
}

function makeGitLogDefault() {
  return [
    "commit abc1234def5678abc1234def5678abc1234def5",
    "Author: Dev One <dev1@example.com>",
    "Date:   Sun Jul 6 10:00:00 2026 +0700",
    "",
    "    Add auth middleware",
    "",
    "    More body detail should be dropped.",
    "    This is padding that consumes tokens."
  ].join("\n");
}

function makeGitLogGraph() {
  return [
    "* abc1234 Add auth middleware",
    "| * def5678 Fix token refresh race",
    "|/",
    "* fedcba9 Update docs"
  ].join("\n");
}

function makeGitLogGraphDefault() {
  return [
    "*   commit abc1234def5678abc1234def5678abc1234def5",
    "|\\",
    "| * commit def5678abc1234def5678abc1234def5678abc1",
    "|/",
    "|",
    "* commit fedcba9abc1234fedcba9abc1234fedcba9abc1234",
    "Author: Dev One <dev1@example.com>",
    "Date:   Sun Jul 6 10:00:00 2026 +0700",
    "",
    "    Add auth middleware",
    ""
  ].join("\n");
}

function makeGitLogWithMerge() {
  return [
    "commit abc1234def5678abc1234def5678abc1234def5",
    "Merge: abc1234 def5678",
    "Author: Dev One <dev1@example.com>",
    "Date:   Sun Jul 6 10:00:00 2026 +0700",
    "",
    "    Merge branch 'feature'"
  ].join("\n");
}

function makeGitLogWithStats() {
  return [
    "commit abc1234def5678abc1234def5678abc1234def5",
    "Author: Dev One <dev1@example.com>",
    "Date:   Sun Jul 6 10:00:00 2026 +0700",
    "",
    "    Fix typo",
    "",
    " 2 files changed, 15 insertions(+), 3 deletions(-)"
  ].join("\n");
}

function makeGitLogWithEmbeddedDiff() {
  return [
    "commit abc1234def5678abc1234def5678abc1234def5",
    "Author: Dev One <dev1@example.com>",
    "Date:   Sun Jul 6 10:00:00 2026 +0700",
    "",
    "    Fix typo",
    "",
    "diff --git a/src/main.js b/src/main.js"
  ].join("\n");
}

describe("gitLog filter", () => {
  it("compresses git log --oneline without losing commit subjects", () => {
    const input = makeGitLogOneline();
    const out = gitLog(input);
    expect(out).toContain("abc1234");
    expect(out).toContain("Add auth middleware");
    expect(out.length).toBeLessThanOrEqual(input.length);
  });

  it("keeps commit header + subject in default git log, drops body detail", () => {
    const input = makeGitLogDefault();
    const out = gitLog(input);
    expect(out).toContain("commit abc1234def5678abc1234def5678abc1234def5");
    expect(out).toContain("Add auth middleware");
    expect(out).not.toContain("More body detail should be dropped.");
  });

  it("strips graph-only decoration but keeps commit subjects", () => {
    const input = makeGitLogGraph();
    const out = gitLog(input);
    expect(out).toContain("abc1234 Add auth middleware");
    expect(out).toContain("def5678 Fix token refresh race");
    expect(out).not.toContain("|/");
  });

  it("returns empty string for empty input", () => {
    expect(gitLog("")).toBe("");
  });

  it("returns empty string for null/undefined input", () => {
    expect(gitLog(null)).toBe("");
    expect(gitLog(undefined)).toBe("");
  });

  it("handles git log --graph without --oneline (graph-prefixed commit headers)", () => {
    const input = makeGitLogGraphDefault();
    const out = gitLog(input);
    expect(out).toContain("commit abc1234def5678abc1234def5678abc1234def5");
    expect(out).toContain("Add auth middleware");
    // graph decoration dropped, pure-graph branch connectors dropped
    expect(out).not.toContain("|\\");
    expect(out).not.toContain("|/");
  });

  it("drops merge commit line ('Merge: abc1234 def5678')", () => {
    const input = makeGitLogWithMerge();
    const out = gitLog(input);
    expect(out).toContain("commit abc1234def5678abc1234def5678abc1234def5");
    expect(out).toContain("Merge branch 'feature'");
    // "Merge:" line should be dropped (not in output)
    expect(out).not.toContain("Merge:");
  });

  it("keeps stat-summary lines verbatim", () => {
    const input = makeGitLogWithStats();
    const out = gitLog(input);
    expect(out).toContain("2 files changed, 15 insertions(+), 3 deletions(-)");
  });

  it("replaces embedded diff markers with '... diff body omitted'", () => {
    const input = makeGitLogWithEmbeddedDiff();
    const out = gitLog(input);
    expect(out).toContain("diff body omitted");
    // Original diff line replaced
    expect(out).not.toContain("diff --git a/src/main.js b/src/main.js");
  });

  it("truncates beyond maxLines and reports skipped count", () => {
    // Generate 50 commit lines but cap at 20
    const lines = [];
    for (let i = 0; i < 50; i++) {
      lines.push(`commit ${String(i).padStart(40, "0")}`);
    }
    const input = lines.join("\n");
    const out = gitLog(input, 20);
    const outLines = out.split("\n").filter(l => l.length > 0);
    expect(outLines.length).toBeLessThanOrEqual(21); // 20 commits + optional skipped note
    expect(out).toContain("more lines");
  });

  it("preserves input when compressed output inflates", () => {
    // Input shorter than output would be — e.g. tiny log
    const input = "abc\ndef";
    const out = gitLog(input, 10);
    expect(out).toBe(input);
  });
});

describe("RTK filters", () => {
  it("gitDiff truncates hunks beyond 100 lines and preserves file header", () => {
    const input = makeLongDiff();
    const out = gitDiff(input, 500);
    expect(out).toContain("foo.js");
    expect(out).toContain("lines truncated");
    expect(out.length).toBeLessThan(input.length);
  });

  it("gitStatus groups by kind and produces compact output (Rust format)", () => {
    const input = makeGitStatus();
    const out = gitStatus(input);
    expect(out).toContain("* main");
    expect(out).toMatch(/~ Modified: \d+ files/);
    expect(out).toContain("src/a.js");
    expect(out.length).toBeLessThan(input.length);
  });

  it("grep groups matches by file and caps per-file lines (Rust format)", () => {
    const input = makeGrepOutput();
    const out = grep(input);
    expect(out).toContain("50 matches in 2F:");
    expect(out).toContain("[file] src/foo.js (40):");
    expect(out).toContain("[file] src/bar.js (10):");
    expect(out).toMatch(/\+\d+/); // overflow marker
    expect(out.length).toBeLessThan(input.length);
  });

  it("find groups paths by parent dir, shows basenames (Rust format)", () => {
    const input = makeFindOutput();
    const out = find(input);
    expect(out).toContain("55 files in 3 dirs:");
    expect(out).toContain("./src/a/  (30)");
    expect(out).toContain("./src/b/  (20)");
    expect(out).toContain("./  (5)");
    expect(out.length).toBeLessThan(input.length);
  });

  it("dedupLog collapses consecutive duplicates", () => {
    const input = Array(20).fill("repeated log line A").join("\n") + "\nunique\n" + Array(10).fill("another dup").join("\n");
    const out = dedupLog(input);
    expect(out).toContain("repeated log line A");
    expect(out).toContain("duplicate lines");
    expect(out.length).toBeLessThan(input.length);
  });
});

describe("autoDetectFilter", () => {
  it("detects git diff", () => {
    expect(autoDetectFilter("diff --git a/x b/x\n@@ -1 +1 @@\n+a").filterName).toBe("git-diff");
  });
  it("detects git status", () => {
    expect(autoDetectFilter("On branch main\n  modified:   x.js\n").filterName).toBe("git-status");
  });
  it("detects grep", () => {
    expect(autoDetectFilter("a.js:1:hello\nb.js:2:world\nc.js:3:foo").filterName).toBe("grep");
  });
  it("detects find", () => {
    expect(autoDetectFilter("./a/b.js\n./a/c.js\n./a/d.js").filterName).toBe("find");
  });
  it("detects git log via commit header", () => {
    const input = [
      "commit abc1234def5678abc1234def5678abc1234def5",
      "Author: Dev One <dev1@example.com>",
      "Date:   Sun Jul 6 10:00:00 2026 +0700",
      "",
      "    Add auth middleware"
    ].join("\n");
    expect(autoDetectFilter(input).filterName).toBe("git-log");
  });
  it("falls back to dedupLog for generic text", () => {
    const txt = "line1\nline2\nline3\nline4\nline5\nline6\n";
    expect(autoDetectFilter(txt).filterName).toBe("dedup-log");
  });
});

describe("RTK filters (extras)", () => {
  it("ls: compact_ls strips perms/owner, keeps name + size", () => {
    const input = [
      "total 48",
      "drwxr-xr-x  2 user staff   64 Jan  1 12:00 .",
      "drwxr-xr-x  2 user staff   64 Jan  1 12:00 ..",
      "drwxr-xr-x  2 user staff   64 Jan  1 12:00 src",
      "-rw-r--r--  1 user staff 1234 Jan  1 12:00 Cargo.toml",
      "-rw-r--r--  1 user staff 5678 Jan  1 12:00 README.md"
    ].join("\n");
    const out = ls(input);
    expect(out).toContain("src/");
    expect(out).toContain("Cargo.toml");
    expect(out).toContain("1.2K");
    expect(out).toContain("5.5K");
    expect(out).not.toContain("drwx");
    expect(out).toContain("Summary: 2 files, 1 dirs");
  });

  it("ls: filters noise dirs", () => {
    const input = [
      "total 8",
      "drwxr-xr-x  2 user staff 64 Jan  1 12:00 node_modules",
      "drwxr-xr-x  2 user staff 64 Jan  1 12:00 .git",
      "drwxr-xr-x  2 user staff 64 Jan  1 12:00 src",
      "-rw-r--r--  1 user staff 100 Jan  1 12:00 main.js"
    ].join("\n");
    const out = ls(input);
    expect(out).not.toContain("node_modules");
    expect(out).not.toContain(".git");
    expect(out).toContain("src/");
    expect(out).toContain("main.js");
  });

  it("tree: removes summary, keeps structure", () => {
    const input = ".\n├── src\n│   └── main.rs\n└── Cargo.toml\n\n2 directories, 3 files\n";
    const out = tree(input);
    expect(out).not.toContain("directories");
    expect(out).toContain("├──");
    expect(out).toContain("main.rs");
  });

  it("smartTruncate: keeps head+tail, drops middle", () => {
    const input = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const out = smartTruncate(input);
    expect(out).toContain("line 0");
    expect(out).toContain("line 399");
    expect(out).toContain("lines truncated");
    expect(out.length).toBeLessThan(input.length);
  });

  it("smartTruncate: passes through small input", () => {
    const input = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    expect(smartTruncate(input)).toBe(input);
  });

  it("readNumbered: compacts very long line-numbered dump", () => {
    const lines = [];
    for (let i = 1; i <= 400; i++) lines.push(`  ${i}|content ${i}`);
    const input = lines.join("\n");
    const out = readNumbered(input);
    expect(out).toContain("1|content 1");
    expect(out).toContain("400|content 400");
    expect(out).toContain("lines truncated");
    expect(out.length).toBeLessThan(input.length);
  });

  it("searchList: groups Cursor Glob output by parent dir", () => {
    const paths = [];
    for (let i = 0; i < 30; i++) paths.push(`- src/a/f${i}.js`);
    for (let i = 0; i < 10; i++) paths.push(`- src/b/g${i}.js`);
    const input = [
      "Result of search in '/Users/x' (total 40 files):",
      ...paths
    ].join("\n");
    const out = searchList(input);
    expect(out).toContain("Result of search in");
    expect(out).toContain("40 files in 2 dirs:");
    expect(out).toContain("src/a/ (30):");
    expect(out).toContain("src/b/ (10):");
    expect(out).toMatch(/\+\d+/);
    expect(out.length).toBeLessThan(input.length);
  });
});

describe("autoDetectFilter (extras)", () => {
  it("detects tree via box-drawing glyphs", () => {
    expect(autoDetectFilter(".\n├── src\n│   └── main.rs\n└── Cargo.toml\n").filterName).toBe("tree");
  });
  it("detects ls via total + perms rows", () => {
    const input = [
      "total 48",
      "drwxr-xr-x  2 user staff   64 Jan  1 12:00 src",
      "-rw-r--r--  1 user staff 1234 Jan  1 12:00 main.js",
      "-rw-r--r--  1 user staff 5678 Jan  1 12:00 README.md"
    ].join("\n");
    expect(autoDetectFilter(input).filterName).toBe("ls");
  });
  it("detects Cursor search list", () => {
    const input = "Result of search in '/x' (total 3 files):\n- a/b.js\n- a/c.js\n- a/d.js";
    expect(autoDetectFilter(input).filterName).toBe("search-list");
  });

  // A space is a valid XY status char, so a porcelain regex written as
  // /^[ MADRCU?!][ MADRCU?!] \S/ also matched any indented line. Claude Code
  // returns Read output as "   N|content" (three spaces, then digits), so real
  // file contents detected as git-status and gitStatus() replaced them with
  // "clean — nothing to commit" — the model lost the file it had just read.
  describe("does not mistake Read output for git status", () => {
    const readOutput = (indent) =>
      Array.from({ length: 60 }, (_, i) => `   ${i + 1}|${indent}const x${i} = ${i};`).join("\n");

    it.each([
      ["unindented", ""],
      ["two-space indent", "  "],
      ["four-space indent", "    "],
    ])("leaves %s Read output alone", (_label, indent) => {
      expect(autoDetectFilter(readOutput(indent))?.filterName).not.toBe("git-status");
    });

    it("keeps the file body intact through compressMessages", () => {
      const lines = Array.from({ length: 500 }, (_, i) =>
        `   ${i + 1}|${i + 1 === 250 ? "export const TARGET = 42;" : `  const filler${i} = ${i};`}`
      );
      const body = { messages: [{ role: "tool", content: lines.join("\n") }] };
      compressMessages(body, true);
      expect(body.messages[0].content).toContain("export const TARGET = 42;");
      expect(body.messages[0].content).not.toBe("clean — nothing to commit");
    });

    it.each([
      [" M", "unstaged modification"],
      ["M ", "staged modification"],
      ["??", "untracked"],
      ["A ", "added"],
          ["D ", "deleted"],
    ])("still detects real porcelain status %j (%s)", (xy) => {
      const input = [`${xy} a.js`, `${xy} b.js`, `${xy} c.js`].join("\n");
      expect(autoDetectFilter(input)?.filterName).toBe("git-status");
    });
  });
});

describe("safeApply", () => {
  it("returns input if filter throws", () => {
    const out = safeApply(() => { throw new Error("boom"); }, "hello");
    expect(out).toBe("hello");
  });
  it("returns input if filter returns non-string", () => {
    const out = safeApply(() => 42, "hello");
    expect(out).toBe("hello");
  });
});

describe("compressMessages (disabled)", () => {
  it("returns null when disabled", () => {
    const body = { messages: [{ role: "tool", tool_call_id: "x", content: makeLongDiff() }] };
    expect(compressMessages(body, false)).toBeNull();
  });
});

describe("compressMessages (enabled)", () => {
  it("compresses OpenAI tool message (string content)", () => {
    const big = makeSafeStatus();
    const body = { messages: [{ role: "tool", tool_call_id: "call_1", content: big }] };
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBeGreaterThan(0);
    expect(body.messages[0].content.length).toBeLessThan(big.length);
    expect(stats.bytesBefore).toBeGreaterThan(stats.bytesAfter);
  });

  it("compresses Claude string-form tool_result", () => {
    const big = makeSafeStatus();
    const body = {
      messages: [{
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: big }]
      }]
    };
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBeGreaterThan(0);
    expect(body.messages[0].content[0].content.length).toBeLessThan(big.length);
  });

  it("compresses Claude array-form tool_result text parts", () => {
    const big = makeSafeStatus();
    const body = {
      messages: [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [{ type: "text", text: big }, { type: "text", text: "unchanged short" }]
        }]
      }]
    };
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBeGreaterThan(0);
    expect(body.messages[0].content[0].content[0].text.length).toBeLessThan(big.length);
    // short part unchanged
    expect(body.messages[0].content[0].content[1].text).toBe("unchanged short");
  });

  it("skips is_error tool_result", () => {
    const big = makeLongDiff();
    const body = {
      messages: [{
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: big, is_error: true }]
      }]
    };
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBe(0);
    expect(body.messages[0].content[0].content).toBe(big);
  });

  it("skips below MIN_COMPRESS_SIZE (<500 bytes)", () => {
    const small = "diff --git a/x b/x\n@@ -1 +1 @@\n+a";
    const body = { messages: [{ role: "tool", tool_call_id: "x", content: small }] };
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBe(0);
    expect(body.messages[0].content).toBe(small);
  });

  it("never produces empty content (R14 guard)", () => {
    const input = "a".repeat(1000);
    const body = { messages: [{ role: "tool", tool_call_id: "x", content: input }] };
    compressMessages(body, true);
    expect(body.messages[0].content.length).toBeGreaterThan(0);
  });

  it("skips when body has no messages", () => {
    expect(compressMessages({})).toBeNull();
    expect(compressMessages({ messages: null })).toBeNull();
  });

  it("handles mix of messages without crashing", () => {
    const body = {
      messages: [
        { role: "system", content: "you are" },
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "x", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: makeGrepOutput() },
        { role: "user", content: [{ type: "text", text: "next" }] }
      ]
    };
    const stats = compressMessages(body, true);
    expect(stats).not.toBeNull();
    expect(stats.hits.length).toBeGreaterThan(0);
  });
});

describe("formatRtkLog", () => {
  it("returns null when no hits", () => {
    expect(formatRtkLog({ bytesBefore: 0, bytesAfter: 0, hits: [] })).toBeNull();
  });
  it("formats savings line with percentage", () => {
    const line = formatRtkLog({ bytesBefore: 1000, bytesAfter: 400, hits: [{ filter: "git-diff" }] });
    expect(line).toContain("saved 600B");
    expect(line).toContain("60.0%");
    expect(line).toContain("git-diff");
  });
});

// RTK_LOSSY=off is the safety switch for agent traffic: it must keep every byte
// of raw file content the model was asked to read, while still summarising the
// outputs that are already condensed tool reports (git status/diff, ls, grep).
// The module reads the env at import time, so each case re-imports it.
describe("lossy guard (RTK_LOSSY)", () => {
  const readOutput = (lines, markLine) =>
    Array.from({ length: lines }, (_, i) => {
      const n = i + 1;
      const body = n === markLine ? 'export const TARGET_SYMBOL = "find-me";' : `  const filler${n} = ${n};`;
      return `   ${n}|${body}`;
    }).join("\n");

  it("RTK_LOSSY=off keeps a >64KB Read body byte-identical", async () => {
    vi.resetModules();
    vi.stubEnv("RTK_LOSSY", "off");
    vi.stubEnv("RTK_HARD_CAP_BYTES", "65536");
    const { compressMessages: compress } = await import("../../open-sse/rtk/index.js");
    const text = readOutput(2500, 1250);
    expect(text.length).toBeGreaterThan(64 * 1024);
    const body = { messages: [{ role: "tool", content: text }] };
    compress(body, true);
    expect(body.messages[0].content).toBe(text);
    expect(body.messages[0].content).toContain("TARGET_SYMBOL");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("RTK_LOSSY=off still summarises git status", async () => {
    vi.resetModules();
    vi.stubEnv("RTK_LOSSY", "off");
    const { compressMessages: compress } = await import("../../open-sse/rtk/index.js");
    const status = " M src/a.js\n M src/b.js\n M src/c.js\n M src/d.js\n?? new1.js\n?? new2.js\n".repeat(20);
    const body = { messages: [{ role: "tool", content: status }] };
    const stats = compress(body, true);
    expect(stats.hits[0].filter).toBe("git-status");
    expect(body.messages[0].content.length).toBeLessThan(status.length);
    expect(body.messages[0].content).toContain("src/a.js");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("default (lossy on) still truncates an oversized Read body", async () => {
    vi.resetModules();
    vi.stubEnv("RTK_LOSSY", "on");
    vi.stubEnv("RTK_HARD_CAP_BYTES", "65536");
    const { compressMessages: compress } = await import("../../open-sse/rtk/index.js");
    const text = readOutput(2500, 1250);
    const body = { messages: [{ role: "tool", content: text }] };
    compress(body, true);
    expect(body.messages[0].content.length).toBeLessThan(text.length);
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
