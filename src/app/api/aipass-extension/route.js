import { readdir, readFile } from "fs/promises";
import path from "path";
import zlib from "zlib";

export const dynamic = "force-dynamic";

// Zip the shipped aipass-extension so the Dashboard can hand users a real
// install artifact instead of "load the extension" with no link. Built
// in-memory with node:zlib (store method for tiny files, deflate when it
// helps) — no dependency added. Served from public/aipass-extension, which
// the Docker build copies into the image; in repo-checkout dev the public
// dir is always present.
const EXTENSION_DIR = path.join(process.cwd(), "public", "aipass-extension");

// little-endian uint32/uint16 writers
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); return b; };

function buildZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = zlib.crc32 ? zlib.crc32(data) : crc32Fallback(data);
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const stored = compressed.length < data.length ? compressed : null;
    const method = stored ? 8 : 0;
    const payload = stored ?? data;

    const localHeader = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(0), u16(0),
      u32(crc), u32(stored ? stored.length : data.length), u32(data.length),
      u16(nameBuf.length), u16(0), nameBuf,
    ]);
    local.push(localHeader, payload);

    const centralHeader = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(method), u16(0), u16(0),
      u32(crc), u32(stored ? stored.length : data.length), u32(data.length),
      u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf,
    ]);
    central.push(centralHeader);
    offset += localHeader.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBuf.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...local, centralBuf, eocd]);
}

function crc32Fallback(buf) {
  let table = crc32Fallback.table;
  if (!table) {
    table = crc32Fallback.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

export async function GET() {
  let files;
  try {
    files = await readdir(EXTENSION_DIR);
  } catch (err) {
    return Response.json(
      { error: { message: `aipass-extension assets not found: ${err?.message ?? err}` } },
      { status: 404 }
    );
  }

  const entries = [];
  for (const file of files.filter((f) => /\.(js|json|html)$/.test(f)).sort()) {
    entries.push({ name: `aipass-extension/${file}`, data: await readFile(path.join(EXTENSION_DIR, file)) });
  }
  if (!entries.some((e) => e.name.endsWith("manifest.json"))) {
    return Response.json(
      { error: { message: "aipass-extension manifest missing — assets incomplete" } },
      { status: 500 }
    );
  }

  const zip = buildZip(entries);
  return new Response(zip, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="aipass-bridge-extension.zip"',
      "Content-Length": String(zip.length),
      "Cache-Control": "no-store",
    },
  });
}