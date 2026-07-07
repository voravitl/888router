import { describe, it, expect } from "vitest";
import { compareModels } from "@/app/(dashboard)/dashboard/providers/[id]/models-table-sort";

describe("compareModels", () => {
  it("lastSyncedAt desc puts null last", () => {
    const a = { id: "a", lastSyncedAt: "2026-01-01T00:00:00.000Z" };
    const b = { id: "b", lastSyncedAt: null };
    // desc → newer first; null should still land last regardless of direction
    expect(compareModels(a, b, "lastSyncedAt", "desc")).toBeLessThan(0);
    expect(compareModels(b, a, "lastSyncedAt", "desc")).toBeGreaterThan(0);
    // asc → oldest first, but null still last
    expect(compareModels(a, b, "lastSyncedAt", "asc")).toBeLessThan(0);
    expect(compareModels(b, a, "lastSyncedAt", "asc")).toBeGreaterThan(0);
  });

  it("null lastSyncedAt on both → falls through to id tie-break asc", () => {
    const a = { id: "zeta", lastSyncedAt: null };
    const b = { id: "alpha", lastSyncedAt: null };
    expect(compareModels(a, b, "lastSyncedAt", "desc")).toBeGreaterThan(0);
    expect(compareModels(b, a, "lastSyncedAt", "desc")).toBeLessThan(0);
  });

  it("tie-break by id ascending regardless of sort direction", () => {
    const a = { id: "b", lastSyncedAt: "2026-01-01T00:00:00.000Z" };
    const b = { id: "a", lastSyncedAt: "2026-01-01T00:00:00.000Z" };
    expect(compareModels(a, b, "lastSyncedAt", "desc")).toBeGreaterThan(0);
    expect(compareModels(a, b, "lastSyncedAt", "asc")).toBeGreaterThan(0);
  });

  it("name sort is case-insensitive", () => {
    const a = { id: "a", name: "Banana" };
    const b = { id: "b", name: "apple" };
    expect(compareModels(a, b, "name", "asc")).toBeGreaterThan(0);
    expect(compareModels(b, a, "name", "asc")).toBeLessThan(0);
  });

  it("name sort falls back to id when name missing", () => {
    const a = { id: "zeta" };
    const b = { id: "alpha" };
    expect(compareModels(a, b, "name", "asc")).toBeGreaterThan(0);
  });

  it("context falls back maxInputTokens → contextLength → 0", () => {
    const withInput = { id: "a", maxInputTokens: 200000 };
    const withContext = { id: "b", contextLength: 100000 };
    const empty = { id: "c" };
    // desc → larger first
    expect(compareModels(withInput, withContext, "context", "desc")).toBeLessThan(0);
    expect(compareModels(withContext, empty, "context", "desc")).toBeLessThan(0);
    expect(compareModels(empty, withInput, "context", "desc")).toBeGreaterThan(0);
    // asc → smaller first
    expect(compareModels(empty, withInput, "context", "asc")).toBeLessThan(0);
  });

  it("lastSyncedAt compares by parsed time", () => {
    const newer = { id: "a", lastSyncedAt: "2026-07-07T12:00:00.000Z" };
    const older = { id: "b", lastSyncedAt: "2026-01-01T00:00:00.000Z" };
    expect(compareModels(newer, older, "lastSyncedAt", "desc")).toBeLessThan(0);
    expect(compareModels(newer, older, "lastSyncedAt", "asc")).toBeGreaterThan(0);
  });

  it("invalid iso treated as 0 (not null)", () => {
    const valid = { id: "a", lastSyncedAt: "2026-01-01T00:00:00.000Z" };
    const invalid = { id: "b", lastSyncedAt: "not-a-date" };
    // invalid → Date.parse NaN → || 0; valid is later → desc puts valid first
    expect(compareModels(valid, invalid, "lastSyncedAt", "desc")).toBeLessThan(0);
  });
});
