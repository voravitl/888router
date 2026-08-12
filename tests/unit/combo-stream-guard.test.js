import { describe, it, expect } from "vitest";
import { createComboStreamGuard } from "../open-sse/services/comboStreamGuard.js";

const enc = (s) => new TextEncoder().encode(s);

describe("comboStreamGuard", () => {
  it("treats a stream with real content as non-empty", () => {
    const g = createComboStreamGuard();
    g.feed(enc("data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n"));
    g.feed(enc("data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n"));
    expect(g.hasDecision()).toBe(true);
    expect(g.isEmpty()).toBe(false);
  });

  it("treats reasoning-only stream ended with length as empty", () => {
    const g = createComboStreamGuard();
    g.feed(enc("data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"thinking...\"}}]}\n\n"));
    g.feed(enc("data: {\"choices\":[{\"delta\":{\"content\":\"\"},\"finish_reason\":\"length\"}]}\n\n"));
    g.feedEnd();
    expect(g.hasDecision()).toBe(true);
    expect(g.isEmpty()).toBe(true);
  });

  it("does not hang on reasoning-only preamble before content", () => {
    const g = createComboStreamGuard();
    for (let i = 0; i < 100; i++) {
      g.feed(enc(`data: {"choices":[{"delta":{"reasoning_content":"step ${i}..."}}]}\n\n`));
    }
    // No terminal, no content yet — decision not made, not empty.
    expect(g.hasDecision()).toBe(false);
    expect(g.isEmpty()).toBe(false);
    // Then content arrives.
    g.feed(enc("data: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}\n\n"));
    expect(g.hasDecision()).toBe(true);
    expect(g.isEmpty()).toBe(false);
  });

  it("marks empty on [DONE] without content", () => {
    const g = createComboStreamGuard();
    g.feed(enc("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"x\"}}]}\n\n"));
    g.feed(enc("data: [DONE]\n\n"));
    expect(g.hasDecision()).toBe(true);
    expect(g.isEmpty()).toBe(true);
  });

  it("recognizes a content delta split across chunk boundaries", () => {
    const g = createComboStreamGuard();
    // "content":"hel"  |  "lo" split mid-line
    g.feed(enc("data: {\"choices\":[{\"delta\":{\"content\":\"hel"));
    g.feed(enc("lo\"}}]}\n\n"));
    g.feed(enc("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"));
    expect(g.hasDecision()).toBe(true);
    expect(g.isEmpty()).toBe(false);
  });

  it("recognizes bare NDJSON lines (no data: prefix)", () => {
    const g = createComboStreamGuard();
    g.feed(enc("{\"choices\":[{\"delta\":{\"content\":\"ndjson-ok\"}}]}\n"));
    g.feed(enc("{\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n"));
    g.feedEnd();
    expect(g.hasDecision()).toBe(true);
    expect(g.isEmpty()).toBe(false);
  });

  it("flushes pending line on feedEnd", () => {
    const g = createComboStreamGuard();
    // Content line without trailing newline, then end-of-stream.
    g.feed(enc("data: {\"choices\":[{\"delta\":{\"content\":\"final\"}}]}\n\n"));
    g.feed(enc("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}"));
    g.feedEnd();
    expect(g.hasDecision()).toBe(true);
    expect(g.isEmpty()).toBe(false);
  });

  it("recognizes ollama NDJSON shape (response/done/done_reason)", () => {
    const g = createComboStreamGuard();
    g.feed(enc("{\"response\":\"Ollama\",\"done\":false}\n"));
    g.feed(enc("{\"response\":\" answer\",\"done\":false}\n"));
    g.feed(enc("{\"response\":\"\",\"done\":true,\"done_reason\":\"stop\"}\n"));
    expect(g.hasDecision()).toBe(true);
    expect(g.isEmpty()).toBe(false);
  });

  it("marks ollama reasoning-only stream as empty", () => {
    const g = createComboStreamGuard();
    // Ollama thinking model: response empty, done with length reason.
    g.feed(enc("{\"response\":\"\",\"done\":true,\"done_reason\":\"length\"}\n"));
    expect(g.hasDecision()).toBe(true);
    expect(g.isEmpty()).toBe(true);
  });

  it("treats clean EOF without terminal marker as empty (no text)", () => {
    const g = createComboStreamGuard();
    // Reader closes cleanly with only reasoning deltas and NO finish marker —
    // some providers close without one. Clean EOF with zero text = empty.
    g.feed(enc("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"x\"}}]}\n\n"));
    g.feedEnd();
    expect(g.hasDecision()).toBe(true); // sawEos
    expect(g.isEmpty()).toBe(true);     // EOF + no text → empty verdict
  });

  it("treats clean [DONE] without content as empty", () => {
    const g = createComboStreamGuard();
    g.feed(enc("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"x\"}}]}\n\n"));
    g.feed(enc("data: [DONE]\n\n"));
    g.feedEnd();
    expect(g.isEmpty()).toBe(true);
  });
});
describe("comboStreamGuard cap-hit regression", () => {
  it("cap hit (reasoning > 64KB) then EOF with no text is EMPTY, not success", () => {
    // The bug: on buffer-cap hit the guard set sawText=true ("release live"),
    // so a stream whose reasoning preamble exceeded 64KB and then ended with
    // zero real content was classified non-empty → client got a 200 SSE with
    // nothing usable → "502 empty stream content" on retry loops.
    const g = createComboStreamGuard();
    // ~28KB of reasoning deltas (no content) — must trip the cap
    // (MAX_BUFFER_BYTES = 64KB; feed() accumulates into the buffer until cap)
    const reasoning = "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"x\"}}]}\n\n";
    for (let i = 0; i < 400; i++) {
      g.feed(enc(reasoning));
      if (g.hasDecision()) break;
    }
    // Cap released the head "live" — guard must NOT have a final decision yet
    // (no text seen, no terminal seen), but after EOF it must classify EMPTY.
    expect(g.hasDecision()).toBe(false); // cap release is not a verdict
    g.feedEnd();
    expect(g.isEmpty()).toBe(true);
  });

  it("cap hit then real text arrives is still non-empty", () => {
    const g = createComboStreamGuard();
    const reasoning = "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"x\"}}]}\n\n";
    for (let i = 0; i < 400; i++) {
      g.feed(enc(reasoning));
      if (g.hasDecision()) break;
    }
    g.feed(enc("data: {\"choices\":[{\"delta\":{\"content\":\"PONG\"}}]}\n\n"));
    expect(g.hasDecision()).toBe(true);
    expect(g.isEmpty()).toBe(false);
  });
});

describe("comboStreamGuard cap-hit + terminal", () => {
  it("cap hit then finish_reason arrives (no EOS) is empty", () => {
    // The ADVISORY gap: cap hit, then an explicit terminal marker (no EOF).
    // isEmpty() must still be true — the cap release never blesses an
    // all-reasoning stream as success.
    const g = createComboStreamGuard();
    const reasoning = "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"x\"}}]}\n\n";
    for (let i = 0; i < 400; i++) {
      g.feed(enc(reasoning));
      if (g.hasDecision()) break;
    }
    g.feed(enc("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n"));
    expect(g.isEmpty()).toBe(true);
  });
});

describe("comboStreamGuard reasoning-budget signature", () => {
  it("exposes sawReasoning + finishReason for a reasoning-only stream", () => {
    // The reasoning_budget_exhausted signature: reasoning deltas then
    // finish_reason:"length" with zero text. combo.js uses these to RETRY
    // instead of treating it as a plain empty verdict.
    const g = createComboStreamGuard();
    g.feed(enc("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking...\"}}]}\n\n"));
    g.feed(enc("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n"));
    expect(g.sawReasoning()).toBe(true);
    expect(g.finishReason()).toBe("length");
    expect(g.isEmpty()).toBe(true); // still empty — combo decides retry
  });

  it("sawReasoning false when only text flows", () => {
    const g = createComboStreamGuard();
    g.feed(enc("data: {\"choices\":[{\"delta\":{\"content\":\"PONG\"}}]}\n\n"));
    expect(g.sawReasoning()).toBe(false);
    expect(g.finishReason()).toBeNull();
    expect(g.isEmpty()).toBe(false);
  });
});
