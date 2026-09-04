import { describe, it, expect } from "vitest";
import { repairDuplicatedJsonArguments } from "../../open-sse/translator/concerns/toolArgs.js";

describe("repairDuplicatedJsonArguments", () => {
  it("leaves single valid JSON untouched", () => {
    const input = JSON.stringify({ command: "ls -la", timeout: 1000 });
    expect(repairDuplicatedJsonArguments(input)).toBe(input);
  });

  it("repairs exact-half duplicated JSON arguments", () => {
    const obj = { path: "/app/data/db", recursive: true };
    const valid = JSON.stringify(obj);
    const duplicated = valid + valid;
    expect(repairDuplicatedJsonArguments(duplicated)).toBe(valid);
  });

  it("does NOT discard distinct concatenated JSON objects (preserves raw)", () => {
    const first = JSON.stringify({ query: "SELECT 1" });
    const second = JSON.stringify({ extra: true });
    const concatenated = first + second;
    expect(repairDuplicatedJsonArguments(concatenated)).toBe(concatenated);
  });

  it("repairs multiple identical concatenated JSON objects even with whitespace", () => {
    const first = JSON.stringify({ query: "SELECT 1" });
    const triple = first + "  " + first + " " + first;
    expect(repairDuplicatedJsonArguments(triple)).toBe(first);
  });

  it("handles strings containing escaped quotes properly", () => {
    const first = JSON.stringify({ message: "quoted \"string\" here" });
    const duplicated = first + first;
    expect(repairDuplicatedJsonArguments(duplicated)).toBe(first);
  });

  it("returns non-string or short inputs untouched", () => {
    expect(repairDuplicatedJsonArguments(null)).toBe(null);
    expect(repairDuplicatedJsonArguments("")).toBe("");
    expect(repairDuplicatedJsonArguments("{}")).toBe("{}");
    expect(repairDuplicatedJsonArguments("bad")).toBe("bad");
  });
});
