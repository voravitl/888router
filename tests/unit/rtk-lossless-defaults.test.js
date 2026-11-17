import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const RTK_ENV_KEYS = [
  "RTK_LOSSY",
  "RTK_SAFE_CAPS",
  "RTK_ON_PRESERVED_INPUT",
  "RTK_HARD_CAP_BYTES",
  "RTK_GREP_PER_FILE_MAX",
  "RTK_STATUS_MAX_FILES",
  "RTK_FIND_PER_DIR_MAX",
  "RTK_FIND_TOTAL_DIR_MAX",
  "RTK_GIT_DIFF_HUNK_MAX_LINES",
  "RTK_GIT_LOG_MAX_LINES",
];

describe("RTK built-in Lossless defaults (no RTK_* env vars set)", () => {
  const saved = {};

  beforeEach(() => {
    vi.resetModules();
    for (const k of RTK_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of RTK_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.resetModules();
  });

  it("defaults isLossyEnabled() to false and SAFE_CAPS_ENABLED to true", async () => {
    const constants = await import("../../open-sse/rtk/constants.js");
    expect(constants.isLossyEnabled()).toBe(false);
    expect(constants.SAFE_CAPS_ENABLED).toBe(true);
  });

  it("keeps >64KB raw Read bodies byte-identical and compacts pretty JSON without env flags", async () => {
    const { compressMessages } = await import("../../open-sse/rtk/index.js");

    const hugeRead = Array.from({ length: 2500 }, (_, i) => {
      const n = i + 1;
      const body = n === 1250 ? 'export const TARGET_SYMBOL = "keep-me";' : `  const x${n} = ${n};`;
      return `   ${n}|${body}`;
    }).join("\n");
    expect(hugeRead.length).toBeGreaterThan(64 * 1024);

    const readBody = { messages: [{ role: "tool", content: hugeRead }] };
    const readStats = compressMessages(readBody, true);
    expect(readStats.hits).toHaveLength(0);
    expect(readBody.messages[0].content).toBe(hugeRead);

    const prettyJson = JSON.stringify({
      error: null,
      docs: "https://example.com/docs",
      items: Array.from({ length: 30 }, (_, i) => ({ id: i, label: `item-${i}` })),
    }, null, 2);
    const jsonBody = { messages: [{ role: "tool", content: prettyJson }] };
    const jsonStats = compressMessages(jsonBody, true);
    expect(jsonStats.hits[0].filter).toBe("json-compact");
    expect(JSON.parse(jsonBody.messages[0].content)).toEqual(JSON.parse(prettyJson));
  });

  it("keeps full listings across grep, gitStatus, and find under default SAFE_CAPS", async () => {
    const { grep } = await import("../../open-sse/rtk/filters/grep.js");
    const { gitStatus } = await import("../../open-sse/rtk/filters/gitStatus.js");
    const { find } = await import("../../open-sse/rtk/filters/find.js");

    const grepIn = Array.from({ length: 25 }, (_, i) => `a.js:${i + 1}:match${i}`).join("\n");
    expect((grep(grepIn).match(/match\d+/g) || []).length).toBe(25);

    const statusIn = Array.from({ length: 30 }, (_, i) => ` M src/f${i}.js`).join("\n");
    expect((gitStatus(statusIn).match(/src\/f\d+/g) || []).length).toBe(30);

    const findIn = Array.from({ length: 40 }, (_, i) => `./dir${i}/file${i}.js`).join("\n");
    expect((find(findIn).match(/file\d+\.js/g) || []).length).toBe(40);
  });

  it("allows opting back into legacy caps via RTK_SAFE_CAPS=off", async () => {
    process.env.RTK_SAFE_CAPS = "off";
    const constants = await import("../../open-sse/rtk/constants.js");
    expect(constants.SAFE_CAPS_ENABLED).toBe(false);
    expect(constants.GREP_PER_FILE_MAX).toBe(10);
  });
});
