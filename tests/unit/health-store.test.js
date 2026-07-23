import { describe, it, expect, beforeEach } from "vitest";
import { healthStore } from "../../open-sse/services/healthStore.js";

describe("HealthStore & Layered Circuit Breaker", () => {
  beforeEach(() => {
    healthStore.clear();
  });

  it("does not open node or provider CB on 429 quota errors", () => {
    healthStore.recordError("providerA", "node1", 429);
    healthStore.recordError("providerA", "node1", 429);
    healthStore.recordError("providerA", "node1", 429);

    expect(healthStore.isNodeOpen("node1")).toBe(false);
    expect(healthStore.isProviderOpen("providerA")).toBe(false);
  });

  it("opens node CB after 3 consecutive 5xx errors", () => {
    healthStore.recordError("providerA", "node1", 502);
    healthStore.recordError("providerA", "node1", 503);
    expect(healthStore.isNodeOpen("node1")).toBe(false);

    healthStore.recordError("providerA", "node1", 500);
    expect(healthStore.isNodeOpen("node1")).toBe(true);
  });

  it("opens provider CB only when min distinct nodes fail", () => {
    healthStore.recordError("providerA", "node1", 500);
    healthStore.recordError("providerA", "node1", 500);
    healthStore.recordError("providerA", "node1", 500); // node1 open

    healthStore.recordError("providerA", "node2", 500);
    healthStore.recordError("providerA", "node2", 500);
    healthStore.recordError("providerA", "node2", 500); // node2 open

    expect(healthStore.isProviderOpen("providerA")).toBe(false);

    healthStore.recordError("providerA", "node3", 500);
    healthStore.recordError("providerA", "node3", 500);
    healthStore.recordError("providerA", "node3", 500); // node3 open

    expect(healthStore.isProviderOpen("providerA")).toBe(true);
  });
});
