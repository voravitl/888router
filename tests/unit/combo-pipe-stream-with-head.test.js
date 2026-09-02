import { describe, it, expect } from "vitest";
import { pipeStreamWithHead } from "open-sse/services/combo.js";

const enc = (s) => new TextEncoder().encode(s);

async function collect(readable) {
  const reader = readable.getReader();
  const out = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

function fakeReader(chunks) {
  // pipeStreamWithHead calls `await reader.read()` directly, not
  // `reader.getReader().read()`, so the mock must expose `.read()`.
  const queue = [...chunks];
  return {
    async read() {
      if (queue.length === 0) return { done: true, value: undefined };
      return { done: false, value: queue.shift() };
    },
    async cancel() {},
  };
}

describe("pipeStreamWithHead (closes #349 investigation)", () => {
  it("emits each upstream chunk exactly once", async () => {
    // 9-free combo (OpenRouter minimax-m3:free) reportedly delivers every
    // assistant record twice. Smoke test: feed distinct chunks and confirm
    // the client sees each exactly once.
    const chunks = [
      enc("data: {\"id\":\"a\",\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n"),
      enc("data: {\"id\":\"b\",\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n"),
      enc("data: [DONE]\n\n"),
    ];
    const out = await collect(pipeStreamWithHead(fakeReader(chunks), null));
    expect(out.length).toBe(3);
  });

  it("preserves head bytes verbatim (prepended before rest of stream)", async () => {
    // The comboStreamGuard buffers the SSE head until it has a verdict, then
    // releases it. pipeStreamWithHead must prepend that head to the rest of
    // the stream so the client sees the full sequence in order.
    const head = enc("data: {\"id\":\"head\",\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n");
    const rest = [
      enc("data: {\"id\":\"body\",\"choices\":[{\"delta\":{\"content\":\"world\"}}]}\n\n"),
      enc("data: [DONE]\n\n"),
    ];
    const out = await collect(pipeStreamWithHead(fakeReader(rest), head));
    expect(out.length).toBe(3);
    const joined = out.map((u) => new TextDecoder().decode(u)).join("");
    expect(joined.indexOf('"id":"head"')).toBeLessThan(joined.indexOf('"id":"body"'));
  });

  it("collapses duplicate chunks when the upstream emits the same payload twice (the reported #349 case)", async () => {
    // Some OpenRouter free models (notably `minimax/minimax-m3:free`) emit the
    // same assistant payload in two consecutive SSE chunks. Before the fix
    // pipeStreamWithHead forwarded both verbatim, so the client saw the record
    // twice (AskUserQuestion in duplicate, tool-call flashes doubled). The
    // dedupSseLines transform now drops the second copy.
    const dup = enc("data: {\"id\":\"x\",\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n");
    const chunks = [dup, dup, enc("data: [DONE]\n\n")];
    const out = await collect(pipeStreamWithHead(fakeReader(chunks), null));
    // 1 dedup'd payload + 1 [DONE] = 2 chunks.
    expect(out.length).toBe(2);
  });

  it("preserves distinct chunks that share a prefix byte-for-byte up to a point", async () => {
    // Adjacent chunks that look similar but differ late in the payload are
    // not duplicates — make sure the dedup only drops byte-identical lines.
    const a = enc("data: {\"id\":\"x\",\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n");
    const b = enc("data: {\"id\":\"x\",\"choices\":[{\"delta\":{\"content\":\"b\"}}]}\n\n");
    const chunks = [a, b, enc("data: [DONE]\n\n")];
    const out = await collect(pipeStreamWithHead(fakeReader(chunks), null));
    expect(out.length).toBe(3);
  });

  it("preserves non-consecutive duplicate tokens throughout the stream (spaces, keywords, punctuation)", async () => {
    // Non-consecutive duplicate tokens (e.g. repeated spaces, keywords, code brackets)
    // must NOT be dropped by global deduping.
    const spaceChunk = enc("data: {\"choices\":[{\"delta\":{\"content\":\" \"}}]}\n\n");
    const wordA = enc("data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n");
    const wordB = enc("data: {\"choices\":[{\"delta\":{\"content\":\"world\"}}]}\n\n");
    const chunks = [wordA, spaceChunk, wordB, spaceChunk, wordA, enc("data: [DONE]\n\n")];
    const out = await collect(pipeStreamWithHead(fakeReader(chunks), null));
    expect(out.length).toBe(6);
  });
});
