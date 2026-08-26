import { describe, it, expect } from "vitest";
import agentrouterConfig from "../../open-sse/providers/registry/agentrouter.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";

describe("AgentRouter Provider & Quota Error Rules", () => {
  it("registers AgentRouter with $200 free tier notice and alternate formats", () => {
    expect(agentrouterConfig.id).toBe("agentrouter");
    expect(agentrouterConfig.display.notice.text).toContain("$200 free credits");
    expect(agentrouterConfig.transport.baseUrl).toBe("https://agentrouter.org/v1/messages");
    expect(agentrouterConfig.transport.alternateFormats).toHaveLength(2);
    expect(PROVIDERS.agentrouter).toBeDefined();
  });

  it("classifies Chinese quota exhaustion '额度不足' as fallback backoff", () => {
    const res = checkFallbackError(400, '{"error":"额度不足，请充值后继续使用"}', 1);
    expect(res.shouldFallback).toBe(true);
    expect(res.newBackoffLevel).toBe(2);
  });

  it("classifies 'user quota exhausted' and 'insufficient_quota' as fallback backoff", () => {
    const res1 = checkFallbackError(403, "User quota exhausted", 0);
    expect(res1.shouldFallback).toBe(true);
    expect(res1.newBackoffLevel).toBe(1);

    const res2 = checkFallbackError(400, "insufficient_quota for current model", 0);
    expect(res2.shouldFallback).toBe(true);
    expect(res2.newBackoffLevel).toBe(1);
  });
});
