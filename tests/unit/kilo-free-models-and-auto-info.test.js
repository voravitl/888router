import { describe, it, expect } from "vitest";
import kiloGateway from "open-sse/providers/registry/kilo-gateway.js";
import { resolveVirtualAutoCombo } from "open-sse/services/autoCombo/virtualFactory.js";

describe("Kilo Gateway & Free Models Integration", () => {
  it("kilo-gateway provider registry includes hasFree and modelsFetcher", () => {
    expect(kiloGateway.hasFree).toBe(true);
    expect(kiloGateway.passthroughModels).toBe(true);
    expect(kiloGateway.modelsFetcher).toEqual({
      url: "https://api.kilo.ai/api/gateway/models",
      type: "openrouter-free",
    });
  });

  it("kilo-gateway registers active free models with valid context windows", () => {
    const ids = kiloGateway.models.map((m) => m.id);
    expect(ids).toContain("kilo-auto/free");
    expect(ids).toContain("stepfun/step-3.7-flash:free");
    expect(ids).toContain("tencent/hy3:free");
    expect(ids).toContain("meituan/longcat-2.0-free");
    expect(ids).toContain("poolside/laguna-s-2.1:free");

    const longcat = kiloGateway.models.find((m) => m.id === "meituan/longcat-2.0-free");
    expect(typeof longcat.contextLength).toBe("number");
    expect(longcat.contextLength).toBeGreaterThan(0);
  });

  it("resolves virtual auto combo auto/best-free-1m correctly", () => {
    const combo = resolveVirtualAutoCombo("auto/best-free-1m");
    expect(combo).toBeDefined();
    expect(combo.models.length).toBeGreaterThan(0);
  });

  it("returns null for non-existent or invalid auto combos", () => {
    const invalid = resolveVirtualAutoCombo("auto/non-existent-combo-xyz");
    expect(invalid).toBeNull();
  });

  it("strictly filters free models using anchored patterns", () => {
    const isKiloFree = (m) => {
      if (!m || typeof m.id !== "string") return false;
      if (m.isFree === true) return true;
      if (m.pricing && m.pricing.prompt === "0" && m.pricing.completion === "0") return true;
      if (m.id.endsWith(":free")) return true;
      if (m.id === "kilo-auto/free" || m.id === "meituan/longcat-2.0-free" || m.id === "openrouter/free") return true;
      return false;
    };

    expect(isKiloFree({ id: "stepfun/step-3.7-flash:free" })).toBe(true);
    expect(isKiloFree({ id: "meituan/longcat-2.0-free" })).toBe(true);
    expect(isKiloFree({ id: "kilo-auto/free" })).toBe(true);
    expect(isKiloFree({ id: "vendor/paid-model-with-free-in-middle" })).toBe(false);
    expect(isKiloFree({ id: "vendor/non-free-model" })).toBe(false);
    expect(isKiloFree({ id: "vendor/free-tier-paid", pricing: { prompt: "0.001", completion: "0.002" } })).toBe(false);
  });
});
