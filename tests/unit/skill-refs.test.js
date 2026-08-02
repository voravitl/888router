import { describe, it, expect } from "vitest";
import { resolveOrigin, absolutizeSkillRefs } from "../../src/shared/skillRefs";

describe("resolveOrigin", () => {
  it("uses NINEROUTER_PUBLIC_URL when set (trusted config beats Host)", () => {
    const env = { NINEROUTER_PUBLIC_URL: "https://gateway.example.com" };
    expect(resolveOrigin("http://localhost:20128/api/skills/raw/x", env)).toBe(
      "https://gateway.example.com"
    );
  });

  it("falls back to request URL origin", () => {
    expect(
      resolveOrigin("http://localhost:20128/api/skills/raw/x", {})
    ).toBe("http://localhost:20128");
  });

  it("rejects non-http(s) schemes", () => {
    expect(resolveOrigin("file:///etc/passwd", {})).toBe("");
  });

  it("does not throw on malformed NINEROUTER_PUBLIC_URL", () => {
    const env = { NINEROUTER_PUBLIC_URL: "not-a-url" };
    expect(resolveOrigin("http://localhost:20128/api/skills/raw/x", env)).toBe(
      "http://localhost:20128"
    );
  });

  it("does not throw on malformed requestUrl", () => {
    expect(resolveOrigin("garbage", {})).toBe("");
  });
});

describe("absolutizeSkillRefs", () => {
  const origin = "http://localhost:20128";

  it("rewrites path-only refs to absolute URLs", () => {
    const content = "See /api/skills/raw/9router for setup.";
    expect(absolutizeSkillRefs(content, origin)).toBe(
      "See http://localhost:20128/api/skills/raw/9router for setup."
    );
  });

  it("rewrites markdown table refs", () => {
    const content = "| Chat | /api/skills/raw/9router-chat |";
    expect(absolutizeSkillRefs(content, origin)).toBe(
      "| Chat | http://localhost:20128/api/skills/raw/9router-chat |"
    );
  });

  it("leaves already-absolute URLs untouched (no double prefix)", () => {
    const content = "See https://example.com/api/skills/raw/keep and http://h/api/skills/raw/k2";
    expect(absolutizeSkillRefs(content, origin)).toBe(content);
  });

  it("handles $ in content safely (replacer function, no interpolation)", () => {
    const content = "Run: echo $NINEROUTER_URL /api/skills/raw/9router";
    const out = absolutizeSkillRefs(content, origin);
    expect(out).toContain("$NINEROUTER_URL");
    expect(out).toContain("http://localhost:20128/api/skills/raw/9router");
  });

  it("returns content unchanged when origin is empty", () => {
    const content = "See /api/skills/raw/9router";
    expect(absolutizeSkillRefs(content, "")).toBe(content);
  });
});
