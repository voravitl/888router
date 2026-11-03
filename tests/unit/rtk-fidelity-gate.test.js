import { describe, it, expect } from "vitest";
import { preservesProtectedContent, __test__ } from "../../open-sse/rtk/fidelity.js";
import { compressMessages } from "../../open-sse/rtk/index.js";

// The gate exists because RTK filters cap their output (git-status shows 10
// files then "+N more"). Dropping the 11th file name is fine until the model is
// asked which files changed — so any rewrite that loses a URL, code block,
// version, path or error line is refused and the original text is kept.
describe("RTK fidelity gate", () => {
  it("accepts a rewrite that keeps every protected token", () => {
    const original = " M src/a.js\n M src/b.js\n?? new.js\n";
    const compressed = "~ Modified: 2 files\n   src/a.js\n   src/b.js\n? Untracked: src/new.js";
    expect(preservesProtectedContent(original, compressed)).toBe(true);
  });

  it.each([
    ["URL", "see https://example.com/docs#section", "see https://example.com"],
    ["code block", "before\n```js\nconst a = 1;\n```\nafter", "before\nafter"],
    ["version", "requires node 22.23.4 or newer", "requires node"],
    ["file path", " M src/deep/nested/file.js", "~ Modified: 1 file"],
    ["error line", "ERROR: cannot resolve module foo", "build finished"],
  ])("rejects a rewrite that drops a %s", (_kind, original, compressed) => {
    expect(preservesProtectedContent(original, compressed)).toBe(false);
  });

  it("treats an unchanged string as preserved", () => {
    expect(preservesProtectedContent("anything", "anything")).toBe(true);
  });

  it("fails open on unexpected input types", () => {
    expect(preservesProtectedContent(null, "x")).toBe(true);
    expect(preservesProtectedContent("x", undefined)).toBe(true);
  });

  it("bounds the token scan so a huge blob cannot stall the gate", () => {
    const many = Array.from({ length: 5000 }, (_, i) => `https://example.com/${i}`).join("\n");
    expect(__test__.protectedTokens(many).size).toBeLessThanOrEqual(400);
  });

  it("refuses the real git-status cap: 40 files must not become 10 + '+30 more'", () => {
    const files = Array.from({ length: 40 }, (_, i) => ` M src/module${i}/file${i}.js`);
    const original = files.join("\n");
    const body = { messages: [{ role: "tool", content: original }] };
    const stats = compressMessages(body, true);
    // The cap would have dropped 30 names; the gate keeps the input instead.
    expect(stats?.refused).toBe(1);
    expect(body.messages[0].content).toBe(original);
    for (const line of files) {
      expect(body.messages[0].content).toContain(line.split(" ")[1]);
    }
  });

  it("still lets a safe listing compress", () => {
    const listing = ["total 48", ...Array.from({ length: 25 }, (_, i) =>
      `-rw-r--r--  1 u s ${i} Jan  1 12:00 file${i}.js`)].join("\n");
    const body = { messages: [{ role: "tool", content: listing }] };
    const stats = compressMessages(body, true);
    expect(stats.hits[0].filter).toBe("ls");
    expect(body.messages[0].content.length).toBeLessThan(listing.length);
    for (let i = 0; i < 25; i++) expect(body.messages[0].content).toContain(`file${i}.js`);
  });
});
