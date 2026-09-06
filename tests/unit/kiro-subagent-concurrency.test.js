import { describe, expect, it, beforeEach } from "vitest";
import { resolveSessionId, resolveContinuationId, clearSessionStore } from "../../open-sse/utils/sessionManager.js";
import { applyKiroSessionReplay, clearKiroSessionReplayStore } from "../../open-sse/utils/kiroSessionReplay.js";

describe("Kiro Subagent Isolation & Session Replay Protection", () => {
  beforeEach(() => {
    clearSessionStore();
    clearKiroSessionReplayStore();
  });

  it("subagents get distinct conversationId under scope=kiro", () => {
    const rootSession = "550e8400-e29b-41d4-a716-446655440000";

    const parentBody = {
      metadata: { user_id: `user_dev_session_${rootSession}` },
      messages: [{ role: "user", content: "Parent: refactor auth module" }],
    };
    const subagentBody = {
      metadata: { user_id: `user_dev_session_${rootSession}_agent_explore_a1b2c3d4` },
      messages: [{ role: "user", content: "Subagent: list files in src/lib" }],
    };

    const parentConvId = resolveSessionId({ body: parentBody, scope: "kiro" });
    const subagentConvId = resolveSessionId({ body: subagentBody, scope: "kiro" });

    expect(parentConvId).toBe(`claude:${rootSession}`);
    expect(subagentConvId).toBe(`claude:${rootSession}_agent_explore_a1b2c3d4`);
    expect(subagentConvId).not.toBe(parentConvId);
  });

  it("subagents receive distinct agentContinuationId from parent", () => {
    const rootSession = "550e8400-e29b-41d4-a716-446655440000";
    const connId = "kiro-conn-123";

    const parentConvId = resolveSessionId({
      body: { metadata: { user_id: `user_dev_session_${rootSession}` } },
      scope: "kiro",
    });
    const subagentConvId = resolveSessionId({
      body: { metadata: { user_id: `user_dev_session_${rootSession}_subagent_task_1` } },
      scope: "kiro",
    });

    const parentContId = resolveContinuationId({ sessionId: parentConvId, connectionId: connId, scope: "kiro" });
    const subagentContId = resolveContinuationId({ sessionId: subagentConvId, connectionId: connId, scope: "kiro" });

    expect(parentContId).toBeDefined();
    expect(subagentContId).toBeDefined();
    expect(subagentContId).not.toBe(parentContId);
  });

  it("subagent does NOT inherit parent sessionStart via applyKiroSessionReplay", () => {
    const rootSession = "550e8400-e29b-41d4-a716-446655440000";
    const connId = "kiro-conn-123";
    const modelId = "claude-3-7-sonnet";

    const parentConvId = resolveSessionId({
      body: { metadata: { user_id: `user_dev_session_${rootSession}` } },
      scope: "kiro",
    });
    const subagentConvId = resolveSessionId({
      body: { metadata: { user_id: `user_dev_session_${rootSession}_agent_explore_xyz` } },
      scope: "kiro",
    });

    // 1. Parent runs turn 1: records parent prompt as sessionStart
    const parentPrompt = "Parent instruction: overhaul the router architecture.";
    const parentReplay = applyKiroSessionReplay({
      conversationId: parentConvId,
      connectionId: connId,
      modelId,
      systemPrompt: "You are an assistant.",
      history: [],
      currentMessage: { userInputMessage: { content: parentPrompt } },
    });
    expect(parentReplay.replayed).toBe(false);

    // 2. Subagent runs with isolated conversationId: must NOT inherit parent's prompt
    const subagentPrompt = "Subagent task: analyze unit tests in tests/unit.";
    const subagentReplay = applyKiroSessionReplay({
      conversationId: subagentConvId,
      connectionId: connId,
      modelId,
      systemPrompt: "You are an assistant.",
      history: [],
      currentMessage: { userInputMessage: { content: subagentPrompt } },
    });

    expect(subagentReplay.replayed).toBe(false);
    expect(subagentReplay.currentMessage.userInputMessage.content).toContain("Subagent task");
    expect(subagentReplay.currentMessage.userInputMessage.content).not.toContain("Parent instruction");
    expect(subagentReplay.history).toEqual([]);
  });
});
