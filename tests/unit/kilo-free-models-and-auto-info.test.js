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
    expect(longcat.contextLength).toBeGreaterThanOrEqual(1000000);
  });

  it("resolves virtual auto combo auto/best-free-1m correctly", () => {
    const combo = resolveVirtualAutoCombo("auto/best-free-1m");
    expect(combo).toBeDefined();
    expect(combo.models.length).toBeGreaterThan(0);
  });
});
