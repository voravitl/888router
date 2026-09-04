import { describe, it, expect } from "vitest";
import {
  parseArgs,
  calculatePercentile,
  MonkeyStats,
  generateMonkeyRequest,
} from "../../scripts/monkey-test.mjs";

describe("Monkey Test CLI & Generator Suite", () => {
  it("should parse default arguments properly", () => {
    const opts = parseArgs([]);
    expect(opts.concurrency).toBe(5);
    expect(opts.duration).toBe(15);
    expect(opts.mode).toBe("mixed");
    expect(opts.chaos).toBe("medium");
    expect(opts.rate).toBe(20);
    expect(opts.streamAbortRate).toBe(0.15);
  });

  it("should parse customized flags correctly", () => {
    const argv = [
      "--url", "http://test:20128/",
      "--concurrency", "12",
      "--duration", "30",
      "--requests", "100",
      "--mode", "router",
      "--chaos", "high",
      "--rate", "5",
      "--models", "model-a,model-b",
      "--stream-abort-rate", "0.25",
      "--verbose",
      "--dry-run",
    ];
    const opts = parseArgs(argv);
    expect(opts.url).toBe("http://test:20128");
    expect(opts.concurrency).toBe(12);
    expect(opts.duration).toBe(30);
    expect(opts.requests).toBe(100);
    expect(opts.mode).toBe("router");
    expect(opts.chaos).toBe("high");
    expect(opts.rate).toBe(5);
    expect(opts.models).toEqual(["model-a", "model-b"]);
    expect(opts.streamAbortRate).toBe(0.25);
    expect(opts.verbose).toBe(true);
    expect(opts.dryRun).toBe(true);
  });

  it("should compute percentiles accurately", () => {
    const data = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(calculatePercentile(data, 50)).toBe(50);
    expect(calculatePercentile(data, 90)).toBe(90);
    expect(calculatePercentile(data, 99)).toBe(100);
    expect(calculatePercentile([], 50)).toBe(0);
  });

  it("should aggregate stats correctly in MonkeyStats", () => {
    const stats = new MonkeyStats();
    stats.record({ action: "ROUTER_VERSION", status: 200, latencyMs: 15 });
    stats.record({ action: "FUZZ_BAD_AUTH", status: 401, latencyMs: 25 });
    stats.record({ action: "FUZZ_MALFORMED", status: 400, latencyMs: 30 });
    stats.record({ action: "LLM_STREAM_ABORT", status: 0, latencyMs: 50, aborted: true });
    stats.record({ action: "CRASH", status: 500, latencyMs: 120 });
    stats.record({ action: "NET_FAIL", status: 0, latencyMs: 10, networkError: true });

    const snap = stats.getSnapshot();
    expect(snap.total).toBe(6);
    expect(snap.ok2xx).toBe(1);
    expect(snap.client4xx).toBe(2);
    expect(snap.server5xx).toBe(1);
    expect(snap.clientAborts).toBe(1);
    expect(snap.networkErrors).toBe(1);
    expect(snap.min).toBe("10");
    expect(snap.max).toBe("120");
    expect(snap.actionCounts["ROUTER_VERSION"]).toBe(1);
  });

  it("should generate router mode requests strictly without live LLM calls", () => {
    const req = generateMonkeyRequest({
      mode: "router",
      chaos: "low",
      models: ["test-model"],
      key: "test-key",
    });
    expect(req.action.startsWith("ROUTER_")).toBe(true);
    expect(req.path).toMatch(/^\/(api|v1)\//);
  });

  it("should generate fuzz mode requests with chaos mutations", () => {
    const req = generateMonkeyRequest({
      mode: "fuzz",
      chaos: "high",
      models: ["test-model"],
      key: "test-key",
    });
    expect(req.action.startsWith("FUZZ_")).toBe(true);
  });

  it("should generate LLM mode requests with OpenAI or Anthropic payload", () => {
    const req = generateMonkeyRequest({
      mode: "llm",
      chaos: "medium",
      models: ["test-model"],
      key: "test-key",
      streamAbortRate: 0,
    });
    expect(req.action.startsWith("LLM_")).toBe(true);
    expect(["/v1/chat/completions", "/v1/messages"]).toContain(req.path);
    const body = JSON.parse(req.body);
    expect(body.model).toBe("test-model");
    expect(body.messages).toBeDefined();
  });
});
