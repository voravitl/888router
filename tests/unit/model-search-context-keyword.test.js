import { describe, it, expect } from "vitest";
import { matchesModelSearch, contextKeywordMin } from "../../src/shared/utils/modelSearch.js";

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

describe("matchesModelSearch — behaviour unchanged for text queries", () => {
  it("still matches plain model names", () => {
    expect(matchesModelSearch({ id: "longcat-2.0", name: "LongCat 2.0" }, "longcat")).toBe(true);
    expect(matchesModelSearch({ id: "glm-5.3-flash" }, "flash")).toBe(true);
  });

  it("does not treat ordinary text as a context filter", () => {
    expect(contextKeywordMin("flash")).toBeNull();
  });
});
