import { describe, it, expect, beforeAll, afterAll } from "vitest";

// RTK's per-filter caps (grep 10/file, git-status 10 files, find 20 dirs) drop
// whole entries. RTK_SAFE_CAPS=on raises every cap so a listing is never cut —
// the saving then comes only from reformatting, never from deleting a name.
// The module reads caps at import time, so this file re-imports under the flag.
const saved = {};

beforeAll(async () => {
  saved.caps = process.env.RTK_SAFE_CAPS;
  process.env.RTK_SAFE_CAPS = "on";
});

afterAll(() => {
  if (saved.caps === undefined) delete process.env.RTK_SAFE_CAPS;
  else process.env.RTK_SAFE_CAPS = saved.caps;
});

async function load() {
  const mods = {
    grep: (await import("../../open-sse/rtk/filters/grep.js")).grep,
    gitStatus: (await import("../../open-sse/rtk/filters/gitStatus.js")).gitStatus,
    find: (await import("../../open-sse/rtk/filters/find.js")).find,
    ls: (await import("../../open-sse/rtk/filters/ls.js")).ls,
  };
  return mods;
}

describe("RTK_SAFE_CAPS keeps every entry", () => {
  it("grep keeps all 25 matches in one file (default cap is 10)", async () => {
    const { grep } = await load();
    const input = Array.from({ length: 25 }, (_, i) => `a.js:${i + 1}:match${i}`).join("\n");
    const out = grep(input);
    expect((out.match(/match\d+/g) || []).length).toBe(25);
  });

  it("git status keeps all 30 modified files (default cap is 10)", async () => {
    const { gitStatus } = await load();
    const input = Array.from({ length: 30 }, (_, i) => ` M src/f${i}.js`).join("\n");
    const out = gitStatus(input);
    expect((out.match(/src\/f\d+/g) || []).length).toBe(30);
  });

  it("find keeps all 40 paths across 40 dirs (default caps are 10/20)", async () => {
    const { find } = await load();
    const input = Array.from({ length: 40 }, (_, i) => `./dir${i}/file${i}.js`).join("\n");
    const out = find(input);
    expect((out.match(/file\d+\.js/g) || []).length).toBe(40);
  });

  it("ls still drops only permissions and dates, never a name", async () => {
    const { ls } = await load();
    const input = ["total 1024"].concat(
      Array.from({ length: 60 }, (_, i) => `-rw-r--r--  1 u s ${1000 + i} Nov  3 10:00 module${i}.js`)
    ).join("\n");
    const out = ls(input);
    for (let i = 0; i < 60; i++) expect(out).toContain(`module${i}.js`);
    expect(out).not.toContain("-rw-r--r--");
    expect(out.length).toBeLessThan(input.length);
  });
});
