import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { compressMessages, formatRtkLog } from "../../open-sse/rtk/index.js";
import { autoDetectFilter } from "../../open-sse/rtk/autodetect.js";
import { FILTERS, isLossyFilter } from "../../open-sse/rtk/constants.js";
import { jsonCompact } from "../../open-sse/rtk/filters/jsonCompact.js";
import { ansiClean } from "../../open-sse/rtk/filters/ansiClean.js";

function makePrettyJsonWithProtectedTokens() {
  const payload = {
    status: "ok",
    error: null,
    failed: false,
    docsUrl: "https://api.example.com/v2/docs#rtk",
    version: "1.2.3",
    sourcePath: "open-sse/rtk/filters/jsonCompact.js",
    nested: {
      failure: null,
      cannotConnect: false,
      snowflakeId: 123456789012345,
      message: "keep   internal   spaces\nand\tquotes \"here\"",
    },
    items: Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      name: `item-${i + 1}`,
      active: i % 2 === 0,
      tags: ["alpha", "beta", "gamma"],
    })),
  };
  return JSON.stringify(payload, null, 2);
}

describe("FILTERS lossless registration", () => {
  it("registers JSON_COMPACT and ANSI_CLEAN as non-lossy filters", () => {
    expect(FILTERS.JSON_COMPACT).toBe("json-compact");
    expect(FILTERS.ANSI_CLEAN).toBe("ansi-clean");
    expect(isLossyFilter(FILTERS.JSON_COMPACT)).toBe(false);
    expect(isLossyFilter(FILTERS.ANSI_CLEAN)).toBe(false);
  });
});

describe("jsonCompact filter", () => {
  it("compacts pretty-printed JSON deterministically while preserving parsed deep-equality", () => {
    const input = makePrettyJsonWithProtectedTokens();
    const out1 = jsonCompact(input);
    const out2 = jsonCompact(input);

    expect(out1).toBe(out2);
    expect(out1.length).toBeLessThan(input.length);
    expect(JSON.parse(out1)).toEqual(JSON.parse(input));
    expect(out1).toContain('"error":null');
    expect(out1).toContain("https://api.example.com/v2/docs#rtk");
    expect(out1).toContain("1.2.3");
    expect(out1).toContain("open-sse/rtk/filters/jsonCompact.js");
    expect(out1).toContain("keep   internal   spaces");
  });

  it("compacts pretty JSON arrays", () => {
    const arr = Array.from({ length: 15 }, (_, i) => ({ idx: i, error: null, path: `src/f${i}.js` }));
    const input = JSON.stringify(arr, null, 2);
    const out = jsonCompact(input);

    expect(out.length).toBeLessThan(input.length);
    expect(JSON.parse(out)).toEqual(arr);
  });

  it("leaves already-compact JSON byte-identical", () => {
    const compact = JSON.stringify(JSON.parse(makePrettyJsonWithProtectedTokens()));
    expect(jsonCompact(compact)).toBe(compact);
  });

  it.each([
    ["malformed JSON", "{ invalid: json, }"],
    ["trailing comma", '{\n  "a": 1,\n}'],
    ["JS code block", "{\n  const a = 1;\n  return a;\n}"],
    ["NDJSON stream", '{"a":1}\n{"b":2}'],
    ["JSON primitive string", '"just a string"'],
    ["JSON primitive number", "42"],
    ["line-numbered code read", '  1|{\n  2|  "a": 1\n  3|}'],
  ])("leaves %s untouched", (_label, input) => {
    expect(jsonCompact(input)).toBe(input);
  });
});

describe("ansiClean filter", () => {
  it("strips SGR, CSI, OSC, and charset escape sequences deterministically", () => {
    const input =
      "\x1b]0;build task\x07" +
      "\x1b[1;32mPASS\x1b[0m \x1b[38;5;208msrc/app.js\x1b[m\x1b[K\n" +
      "\x1b[38;2;255;0;0mERROR:\x1b[0m \x1b(Bcheck \x1b]8;;https://example.com\x07https://example.com\x1b]8;;\x07\n";
    const expected =
      "PASS src/app.js\n" +
      "ERROR: check https://example.com\n";

    expect(ansiClean(input)).toBe(expected);
    expect(ansiClean(input)).toBe(ansiClean(input));
  });

  it("collapses \\r progress frames keeping only final overwrite per line", () => {
    const input = [
      "Downloading 10%\rDownloading 50%\rDownloading 100%",
      "\x1b[33mSpinner /\x1b[0m\r\x1b[K\x1b[32mLoaded 42 modules\x1b[0m",
      "Done.",
    ].join("\n");

    expect(ansiClean(input)).toBe([
      "Downloading 100%",
      "Loaded 42 modules",
      "Done.",
    ].join("\n"));

    expect(ansiClean("Trailing progress\rFinal state\r")).toBe("Final state");
  });

  it("handles \\r\\x1b[K cleared progress lines and preserves CRLF line endings", () => {
    const cleared = "Working...\r\x1b[K\nFinished\r\nNext line\r\n";
    expect(ansiClean(cleared)).toBe("\nFinished\r\nNext line\r\n");

    const progressWithCrlf = "Step 1\rStep 2\r\nStep 3\r\n";
    expect(ansiClean(progressWithCrlf)).toBe("Step 2\r\nStep 3\r\n");
  });

  it.each([
    ["plain text", "hello world\nsecond line\n"],
    ["CRLF text", "line 1\r\nline 2\r\n"],
    ["source code with escaped \\x1b literal", '  1|const red = "\\x1b[31m";\n  2|const cr = "\\r";\n'],
    ["empty string", ""],
  ])("leaves normal %s completely untouched", (_label, input) => {
    expect(ansiClean(input)).toBe(input);
  });
});

describe("autoDetectFilter with JSON and ANSI/CR", () => {
  it("detects pretty-printed JSON as json-compact", () => {
    const pretty = makePrettyJsonWithProtectedTokens();
    expect(autoDetectFilter(pretty)?.filterName).toBe(FILTERS.JSON_COMPACT);
  });

  it("does not detect invalid JSON or line-numbered files as json-compact", () => {
    expect(autoDetectFilter("{ not: valid json }")?.filterName).not.toBe(FILTERS.JSON_COMPACT);
    const readDump = '  1|{\n  2|  "name": "app"\n  3|}';
    expect(autoDetectFilter(readDump)?.filterName).not.toBe(FILTERS.JSON_COMPACT);
  });

  it("detects ANSI-colored git-status porcelain and long-form", () => {
    const ansiPorcelain = [
      "\x1b[31m M src/a.js\x1b[m",
      "\x1b[32mA  src/b.js\x1b[m",
      "\x1b[31m?? src/c.js\x1b[m",
    ].join("\n");
    const fn = autoDetectFilter(ansiPorcelain);
    expect(fn?.filterName).toBe(FILTERS.GIT_STATUS);
    expect(fn(ansiPorcelain)).toContain("src/a.js");

    const ansiLong = [
      "\x1b[36mOn branch main\x1b[m",
      "Changes not staged for commit:",
      "\t\x1b[31mmodified:   src/x.js\x1b[m",
    ].join("\n");
    expect(autoDetectFilter(ansiLong)?.filterName).toBe(FILTERS.GIT_STATUS);
  });

  it("detects ANSI-colored git-diff", () => {
    const ansiDiff = [
      "\x1b[1mdiff --git a/src/foo.js b/src/foo.js\x1b[m",
      "\x1b[1mindex 1111111..2222222 100644\x1b[m",
      "\x1b[1m--- a/src/foo.js\x1b[m",
      "\x1b[1m+++ b/src/foo.js\x1b[m",
      "\x1b[36m@@ -1,2 +1,3 @@\x1b[m",
      "\x1b[32m+const ok = true;\x1b[m",
    ].join("\n");
    const fn = autoDetectFilter(ansiDiff);
    expect(fn?.filterName).toBe(FILTERS.GIT_DIFF);
    expect(fn(ansiDiff)).toContain("const ok = true;");
  });
});

describe("compressMessages lossless integration (RTK_LOSSY=off, RTK_ON_PRESERVED_INPUT=on)", () => {
  beforeEach(() => {
    vi.stubEnv("RTK_LOSSY", "off");
    vi.stubEnv("RTK_SAFE_CAPS", "on");
    vi.stubEnv("RTK_ON_PRESERVED_INPUT", "on");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("compacts pretty JSON containing error:null, URLs, versions, and paths under RTK_LOSSY=off", () => {
    const pretty = makePrettyJsonWithProtectedTokens();
    expect(pretty.length).toBeGreaterThan(500);

    const body1 = {
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: pretty }] },
      ],
    };
    const body2 = structuredClone(body1);

    const stats1 = compressMessages(body1, true);
    const stats2 = compressMessages(body2, true);

    const out1 = body1.messages[0].content[0].content;
    const out2 = body2.messages[0].content[0].content;

    expect(stats1.refused).toBeUndefined();
    expect(stats1.hits).toHaveLength(1);
    expect(stats1.hits[0].filter).toBe(FILTERS.JSON_COMPACT);
    expect(out1.length).toBeLessThan(pretty.length);
    expect(out1).toBe(out2); // deterministic for prompt caching
    expect(JSON.parse(out1)).toEqual(JSON.parse(pretty));
    expect(out1).toContain('"error":null');
    expect(out1).toContain("https://api.example.com/v2/docs#rtk");
    expect(out1).toContain("1.2.3");
    expect(out1).toContain("open-sse/rtk/filters/jsonCompact.js");
    expect(formatRtkLog(stats1)).toContain("json-compact");
  });

  it("leaves invalid JSON and already-compact JSON untouched in compressMessages", () => {
    const alreadyCompact = JSON.stringify(JSON.parse(makePrettyJsonWithProtectedTokens()));
    const invalidJson = "{\n  broken: true,\n" + "  foo: 'bar',\n".repeat(40) + "}";

    const body = {
      messages: [
        { role: "tool", content: alreadyCompact },
        { role: "tool", content: invalidJson },
      ],
    };
    const stats = compressMessages(body, true);

    expect(stats.hits).toHaveLength(0);
    expect(body.messages[0].content).toBe(alreadyCompact);
    expect(body.messages[1].content).toBe(invalidJson);
  });

  it("never compacts raw 1|code file reads when RTK_LOSSY=off (even if code contains JSON)", () => {
    const rawCode = Array.from({ length: 40 }, (_, i) => {
      const n = i + 1;
      return `  ${n}|const item${n} = { "error": null, "id": ${n} };`;
    }).join("\n");
    expect(rawCode.length).toBeGreaterThan(500);

    const body = {
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: rawCode }] }] },
      ],
    };
    const stats = compressMessages(body, true);

    expect(stats.hits).toHaveLength(0);
    expect(body.messages[0].content[0].content[0].text).toBe(rawCode);
  });

  it("strips ANSI + collapses \\r progress frames cleanly even on error lines and git-status under RTK_LOSSY=off", () => {
    const ansiErrorLog = [
      ...Array.from({ length: 12 }, (_, i) => `\x1b[90m[${i}]\x1b[0m step ${i} \x1b[33mrunning\x1b[0m\r\x1b[32m[${i}] step ${i} done\x1b[0m`),
      "\x1b[31mERROR: failed connecting to https://api.example.com/health (1.2.3)\x1b[0m",
    ].join("\n");
    expect(ansiErrorLog.length).toBeGreaterThan(500);

    const ansiGitStatus = [
      "\x1b[36mOn branch main\x1b[m",
      "Changes not staged for commit:",
      '  (use "git add <file>..." to update what will be committed)',
      '  (use "git restore <file>..." to discard changes in working directory)',
      '  (commit or discard the untracked or modified content in submodules)',
      ...Array.from({ length: 10 }, (_, i) => `\x1b[31m M src/module/file${i}.js\x1b[m`),
    ].join("\n");
    expect(ansiGitStatus.length).toBeGreaterThan(500);

    const body = {
      messages: [
        { role: "tool", content: ansiErrorLog },
        { role: "tool", content: ansiGitStatus },
      ],
    };
    const stats = compressMessages(body, true);

    expect(stats.refused).toBeUndefined();
    expect(stats.hits).toHaveLength(2);
    expect(body.messages[0].content).not.toContain("\x1b");
    expect(body.messages[0].content).not.toContain("\r");
    expect(body.messages[0].content).not.toContain("running");
    expect(body.messages[0].content).toContain("ERROR: failed connecting to https://api.example.com/health (1.2.3)");

    expect(body.messages[1].content).not.toContain("\x1b");
    expect(body.messages[1].content).toContain("* main");
    expect(body.messages[1].content).toContain("src/module/file0.js");
    expect(body.messages[1].content).toContain("src/module/file9.js");
    expect(stats.hits[1].filter).toContain(FILTERS.GIT_STATUS);
  });

  it("preserves exact 64-bit integer literals and escaped slashes without precision loss", () => {
    const rawJson = [
      "{",
      '  "snowflake": 1234567890123456789,',
      '  "negativeZero": -0,',
      '  "escapedUrl": "https:\\/\\/example.com\\/v1",',
      '  "error": null,',
      '  "padding": "' + "x".repeat(500) + '"',
      "}",
    ].join("\n");

    const body = { messages: [{ role: "tool", content: rawJson }] };
    const stats = compressMessages(body, true);

    expect(stats.hits).toHaveLength(1);
    expect(stats.hits[0].filter).toBe(FILTERS.JSON_COMPACT);
    expect(body.messages[0].content).toContain("1234567890123456789");
    expect(body.messages[0].content).toContain('"escapedUrl":"https:\\/\\/example.com\\/v1"');
    expect(JSON.parse(body.messages[0].content)).toEqual(JSON.parse(rawJson));
  });

  it("handles ANSI-colored git-diff in compressMessages without dropping diff content", () => {
    const ansiDiff = [
      "\x1b[1mdiff --git a/src/foo.js b/src/foo.js\x1b[m",
      "\x1b[1mindex 1111111..2222222 100644\x1b[m",
      "\x1b[1m--- a/src/foo.js\x1b[m",
      "\x1b[1m+++ b/src/foo.js\x1b[m",
      "\x1b[36m@@ -1,5 +1,12 @@\x1b[m",
      ...Array.from({ length: 12 }, (_, i) => `\x1b[32m+const line${i} = "value-${i}";\x1b[m`),
    ].join("\n");
    expect(ansiDiff.length).toBeGreaterThan(500);

    const body = { messages: [{ role: "tool", content: ansiDiff }] };
    const stats = compressMessages(body, true);

    expect(stats.hits).toHaveLength(1);
    expect(body.messages[0].content).not.toContain("\x1b");
    expect(body.messages[0].content).toContain("src/foo.js");
    expect(body.messages[0].content).toContain('const line11 = "value-11";');
  });

  it("falls back to lossless compacted JSON when post-compaction hard-cap drops protected tokens", async () => {
    vi.resetModules();
    vi.stubEnv("RTK_LOSSY", "on");
    vi.stubEnv("RTK_HARD_CAP_BYTES", "300");
    const { compressMessages: compress } = await import("../../open-sse/rtk/index.js");

    const hugePrettyJson = JSON.stringify({
      prefix: "a".repeat(250),
      middleUrl: "https://must-not-drop.example.com/resource",
      error: null,
      suffix: "b".repeat(250),
    }, null, 2);

    const body = { messages: [{ role: "tool", content: hugePrettyJson }] };
    const stats = compress(body, true);

    expect(stats.refused).toBe(1);
    expect(stats.hits[0].filter).toBe(FILTERS.JSON_COMPACT);
    expect(body.messages[0].content).toContain("https://must-not-drop.example.com/resource");
    expect(JSON.parse(body.messages[0].content)).toEqual(JSON.parse(hugePrettyJson));
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("combines ANSI clean + JSON compaction for ANSI-colored pretty JSON", () => {
    const pretty = makePrettyJsonWithProtectedTokens();
    const coloredJson = pretty
      .split("\n")
      .map(line => `\x1b[34m${line}\x1b[0m`)
      .join("\n");

    const body = { messages: [{ role: "tool", content: coloredJson }] };
    const stats = compressMessages(body, true);

    expect(stats.refused).toBeUndefined();
    expect(stats.hits).toHaveLength(1);
    expect(stats.hits[0].filter).toContain(FILTERS.JSON_COMPACT);
    expect(JSON.parse(body.messages[0].content)).toEqual(JSON.parse(pretty));
    expect(body.messages[0].content.length).toBeLessThan(pretty.length);
  });

  it("compacts pretty JSON across OpenAI Responses, Gemini, and Kiro shapes", () => {
    const pretty = makePrettyJsonWithProtectedTokens();
    const responsesBody = { input: [{ type: "function_call_output", output: pretty }] };
    const geminiBody = { contents: [{ role: "function", parts: [{ functionResponse: { name: "mcp", response: { output: pretty } } }] }] };
    const kiroBody = {
      conversationState: {
        currentMessage: {
          userInputMessage: {
            userInputMessageContext: {
              toolResults: [{ status: "success", content: [{ text: pretty }] }],
            },
          },
        },
      },
    };

    expect(compressMessages(responsesBody, true).hits[0].filter).toBe(FILTERS.JSON_COMPACT);
    expect(compressMessages(geminiBody, true).hits[0].filter).toBe(FILTERS.JSON_COMPACT);
    expect(compressMessages(kiroBody, true).hits[0].filter).toBe(FILTERS.JSON_COMPACT);
    expect(JSON.parse(responsesBody.input[0].output)).toEqual(JSON.parse(pretty));
    expect(JSON.parse(geminiBody.contents[0].parts[0].functionResponse.response.output)).toEqual(JSON.parse(pretty));
    expect(JSON.parse(kiroBody.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults[0].content[0].text)).toEqual(JSON.parse(pretty));
  });
});
