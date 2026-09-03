import { beforeEach, describe, expect, it, vi } from "vitest";

// /api/aipass-extension must serve a valid zip of public/aipass-extension —
// the Dashboard's only install artifact for the AiPASS bridge extension
// (#377 follow-up: "จริงๆ มันควรมี link ให้ติดตั้ง extension").
// Zip correctness is verified structurally: local file headers + central
// directory + EOCD, and round-trips through Node's zlib inflate.

const mocks = vi.hoisted(() => ({ readdir: vi.fn(), readFile: vi.fn() }));

vi.mock("fs/promises", () => ({
  readdir: mocks.readdir,
  readFile: mocks.readFile,
  default: { readdir: mocks.readdir, readFile: mocks.readFile },
}));

// Route resolves EXTENSION_DIR via process.cwd()/public/aipass-extension; the
// real repo dir is present in tests, but stub fs so the test is hermetic.
vi.mock("path", async (importOriginal) => ({
  ...(await importOriginal()),
  join: (...segs) => segs.join("/"),
}));

function parseZip(buf) {
  // EOCD is the last 22+ bytes; comment length is 0 for our builder.
  const eocdSig = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocdSig).toBeGreaterThan(0);
  const cdSize = buf.readUInt32LE(eocdSig + 12);
  const cdOffset = buf.readUInt32LE(eocdSig + 16);
  expect(buf.readUInt32LE(cdOffset)).toBe(0x02014b50); // central dir starts here

  const entries = [];
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  while (p < cdEnd) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");

    // walk to the local header for the payload
    expect(buf.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const extraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + extraLen;
    const payload = buf.subarray(dataStart, dataStart + compSize);
    entries.push({ name, method, crc, compSize, uncompSize, payload });
    p += 46 + nameLen;
  }
  return entries;
}

describe("/api/aipass-extension download (#377)", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.readdir.mockReset();
    mocks.readFile.mockReset();
  });

  it("serves a structurally valid zip containing the extension files", async () => {
    mocks.readdir.mockResolvedValue([
      "background.js", "content.js", "manifest.json", "offscreen.html",
      "offscreen.js", "page.js", "popup.html", "popup.js",
    ]);
    mocks.readFile.mockImplementation(async (p) => {
      const name = String(p).split("/").pop();
      return Buffer.from(`// fake content of ${name}\n`);
    });

    const { GET } = await import("../../src/app/api/aipass-extension/route.js");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain("aipass-bridge-extension.zip");

    const buf = Buffer.from(await res.arrayBuffer());
    const entries = parseZip(buf);
    const names = entries.map((e) => e.name);
    expect(names).toContain("aipass-extension/manifest.json");
    expect(names).toContain("aipass-extension/background.js");
    expect(names).toContain("aipass-extension/offscreen.js");
    expect(names).toHaveLength(8);

    // round-trip: inflate the payload and compare with what readFile returned
    for (const e of entries) {
      const expected = Buffer.from(`// fake content of ${e.name.split("/")[1]}\n`);
      let out;
      if (e.method === 8) out = (await import("zlib")).inflateRawSync(e.payload);
      else out = e.payload;
      expect(out.equals(expected)).toBe(true);
      expect(e.uncompSize).toBe(expected.length);
    }
  });

  it("404s when the assets dir is missing", async () => {
    mocks.readdir.mockRejectedValue(new Error("ENOENT"));
    const { GET } = await import("../../src/app/api/aipass-extension/route.js");
    const res = await GET();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.message).toMatch(/not found/);
  });

  it("500s when manifest.json is absent from the dir", async () => {
    mocks.readdir.mockResolvedValue(["background.js"]);
    mocks.readFile.mockResolvedValue(Buffer.from("x"));
    const { GET } = await import("../../src/app/api/aipass-extension/route.js");
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toMatch(/manifest missing/);
  });
});