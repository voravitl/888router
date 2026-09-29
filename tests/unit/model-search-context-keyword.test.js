import { describe, it, expect } from "vitest";
import { matchesModelSearch, contextKeywordMin, splitContextQuery } from "../../src/shared/utils/modelSearch.js";

describe("contextKeywordMin — shorthand typed into search", () => {
  it("recognises the common context shorthands", () => {
    expect(contextKeywordMin("1m")).toBe(1_000_000);
    expect(contextKeywordMin("500k")).toBe(500_000);
    expect(contextKeywordMin("200k")).toBe(200_000);
    expect(contextKeywordMin("128k")).toBe(128_000);
    expect(contextKeywordMin("256k")).toBe(256_000);
    expect(contextKeywordMin("1048756")).toBe(1_000_000);
  });

  it("is case-insensitive and ignores whitespace", () => {
    expect(contextKeywordMin(" 1M ")).toBe(1_000_000);
    expect(contextKeywordMin("200K")).toBe(200_000);
  });

  it("returns null for ordinary search text", () => {
    expect(contextKeywordMin("sonnet")).toBeNull();
    expect(contextKeywordMin("minimax flash")).toBeNull();
    expect(contextKeywordMin("longcat")).toBeNull();
    expect(contextKeywordMin("")).toBeNull();
  });
});

describe("splitContextQuery — compound queries", () => {
  it("pure keyword: empty text + the context predicate", () => {
    expect(splitContextQuery("1m")).toEqual({ text: "", ctxMin: 1_000_000 });
    expect(splitContextQuery("500k")).toEqual({ text: "", ctxMin: 500_000 });
  });

  it("compound: keyword token becomes the predicate, rest stays text", () => {
    expect(splitContextQuery("flash 1m")).toEqual({ text: "flash", ctxMin: 1_000_000 });
    expect(splitContextQuery("1m flash")).toEqual({ text: "flash", ctxMin: 1_000_000 });
    expect(splitContextQuery("grok 500k")).toEqual({ text: "grok", ctxMin: 500_000 });
  });

  it("anchored regex: near-miss tokens stay text, no leak", () => {
    expect(splitContextQuery("m200")).toEqual({ text: "m200", ctxMin: null });
    expect(splitContextQuery("1m2")).toEqual({ text: "1m2", ctxMin: null });
    expect(splitContextQuery("500")).toEqual({ text: "500", ctxMin: null });
  });

  it("first keyword wins when two keywords are typed (documented semantics)", () => {
    expect(splitContextQuery("1m 500k")).toEqual({ text: "500k", ctxMin: 1_000_000 });
    expect(splitContextQuery("500k 1m")).toEqual({ text: "1m", ctxMin: 500_000 });
  });

  it("ordinary text: null predicate, text preserved verbatim (hyphen-normalised)", () => {
    expect(splitContextQuery("longcat")).toEqual({ text: "longcat", ctxMin: null });
    expect(splitContextQuery("sonnet-flash")).toEqual({ text: "sonnet flash", ctxMin: null });
  });
});

describe("matchesModelSearch — behaviour unchanged for text queries", () => {
  it("still matches plain model names", () => {
    expect(matchesModelSearch({ id: "longcat-2.0", name: "LongCat 2.0" }, "longcat")).toBe(true);
    expect(matchesModelSearch({ id: "glm-5.3-flash" }, "flash")).toBe(true);
  });

  it("does not treat ordinary text as a context filter", () => {
    expect(contextKeywordMin("flash")).toBeNull();
  });
});
