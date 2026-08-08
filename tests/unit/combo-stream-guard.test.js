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
});