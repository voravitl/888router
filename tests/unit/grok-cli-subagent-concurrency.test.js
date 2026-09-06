import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

import { GrokCliExecutor, _resetGrokCliTurnStore } from "../../open-sse/executors/grok-cli.js";
import { resolveSessionId } from "../../open-sse/utils/sessionManager.js";
import { translateRequest } from "../../open-sse/translator/index.js";

describe("Grok-CLI Subagent Concurrency & Isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetGrokCliTurnStore();
    mocks.proxyAwareFetch.mockResolvedValue(
      new Response("data: {}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    );
  });

  it("subagents get distinct session IDs under scope=grok-cli (agent, subagent, task, sidecar)", () => {
    const rootSession = "98765432-4321-4321-4321-9876543210ab";

    const parentBody = {
      metadata: { user_id: `user_dev_session_${rootSession}` },
      input: [{ role: "user", content: "Parent task" }],
    };
    const sub1Body = {
      metadata: { user_id: `user_dev_session_${rootSession}_agent_task_alpha` },
      input: [{ role: "user", content: "Subtask Alpha" }],
    };
    const sub2Body = {
      metadata: { user_id: `user_dev_session_${rootSession}_subagent_beta_99` },
      input: [{ role: "user", content: "Subtask Beta" }],
    };
    const sub3Body = {
      metadata: { user_id: `user_dev_session_${rootSession}_sidecar-worker-1` },
      input: [{ role: "user", content: "Subtask Sidecar" }],
    };

    const parentSess = resolveSessionId({ body: parentBody, scope: "grok-cli" });
    const sub1Sess = resolveSessionId({ body: sub1Body, scope: "grok-cli" });
    const sub2Sess = resolveSessionId({ body: sub2Body, scope: "grok-cli" });
    const sub3Sess = resolveSessionId({ body: sub3Body, scope: "grok-cli" });

    expect(parentSess).toBe(`claude:${rootSession}`);
    expect(sub1Sess).toBe(`claude:${rootSession}_agent_task_alpha`);
    expect(sub2Sess).toBe(`claude:${rootSession}_subagent_beta_99`);
    expect(sub3Sess).toBe(`claude:${rootSession}_sidecar-worker-1`);

    expect(sub1Sess).not.toBe(parentSess);
    expect(sub2Sess).not.toBe(parentSess);
    expect(sub1Sess).not.toBe(sub2Sess);
    expect(sub1Sess).not.toBe(sub3Sess);
  });

  it("concurrent requests sharing one GrokCliExecutor instance do not cross-pollute headers and send real requests", async () => {
    const executor = new GrokCliExecutor();
    const sharedBaseCreds = {
      accessToken: "grok-cli-oauth-token",
      connectionId: "conn-shared",
      providerSpecificData: { deviceId: "device-12345" },
    };

    const bodyA = {
      model: "grok-4",
      session_id: "session-AAA",
      input: [{ type: "message", role: "user", content: "Task A" }],
    };
    const bodyB = {
      model: "grok-4.5",
      session_id: "session-BBB",
      input: [
        { type: "message", role: "user", content: "Turn 1" },
        { type: "message", role: "assistant", content: "Ans 1" },
        { type: "message", role: "user", content: "Turn 2" },
      ],
    };

    await Promise.all([
      executor.execute({ model: "grok-4", body: bodyA, stream: true, credentials: sharedBaseCreds }),
      executor.execute({ model: "grok-4.5", body: bodyB, stream: true, credentials: sharedBaseCreds }),
    ]);

    // Base shared credentials must remain unpolluted
    expect(sharedBaseCreds._currentSessionId).toBeUndefined();
    expect(sharedBaseCreds._currentReqId).toBeUndefined();
    expect(sharedBaseCreds._currentTurnIdx).toBeUndefined();

    // Verify proxyAwareFetch received 2 calls
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(2);

    const callA = mocks.proxyAwareFetch.mock.calls.find((c) => c[1].headers["x-grok-session-id"] === "session-AAA");
    const callB = mocks.proxyAwareFetch.mock.calls.find((c) => c[1].headers["x-grok-session-id"] === "session-BBB");

    expect(callA).toBeDefined();
    expect(callB).toBeDefined();

    expect(callA[1].headers["x-grok-session-id"]).toBe("session-AAA");
    expect(callA[1].headers["x-grok-conv-id"]).toBe("session-AAA");
    expect(callA[1].headers["x-grok-model-override"]).toBe("grok-4");
    expect(callA[1].headers["x-grok-turn-idx"]).toBe("1");

    expect(callB[1].headers["x-grok-session-id"]).toBe("session-BBB");
    expect(callB[1].headers["x-grok-conv-id"]).toBe("session-BBB");
    expect(callB[1].headers["x-grok-model-override"]).toBe("grok-4.5");
    expect(callB[1].headers["x-grok-turn-idx"]).toBe("2");
  });

  it("end-to-end: Claude Code request translated to openai-responses for grok-cli isolates parent and subagent", async () => {
    const executor = new GrokCliExecutor();
    const rootSession = "44445555-6666-7777-8888-99990000aaaa";
    const sharedCreds = {
      accessToken: "grok-token-test",
      connectionId: "conn-e2e",
      providerSpecificData: { deviceId: "device-e2e" },
    };

    const parentClaudeBody = {
      model: "claude-3-7-sonnet",
      metadata: { user_id: `user_dev_session_${rootSession}` },
      messages: [{ role: "user", content: "Parent task" }],
    };
    const subagentClaudeBody = {
      model: "claude-3-7-sonnet",
      metadata: { user_id: `user_dev_session_${rootSession}_agent_task_worker` },
      messages: [{ role: "user", content: "Subagent worker task" }],
    };

    const parentReqCreds = Object.assign(Object.create(sharedCreds), {});
    const subagentReqCreds = Object.assign(Object.create(sharedCreds), {});

    const translatedParent = translateRequest("claude", "openai-responses", "grok-4", parentClaudeBody, true, parentReqCreds, "grok-cli");
    const translatedSubagent = translateRequest("claude", "openai-responses", "grok-4", subagentClaudeBody, true, subagentReqCreds, "grok-cli");

    // Translator must capture clientSessionId from original Claude metadata
    expect(parentReqCreds._clientSessionId).toBe(`claude:${rootSession}`);
    expect(subagentReqCreds._clientSessionId).toBe(`claude:${rootSession}_agent_task_worker`);

    await Promise.all([
      executor.execute({ model: "grok-4", body: translatedParent, stream: true, credentials: parentReqCreds }),
      executor.execute({ model: "grok-4", body: translatedSubagent, stream: true, credentials: subagentReqCreds }),
    ]);

    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(2);

    const callParent = mocks.proxyAwareFetch.mock.calls.find((c) => c[1].headers["x-grok-session-id"] === `claude:${rootSession}`);
    const callSubagent = mocks.proxyAwareFetch.mock.calls.find((c) => c[1].headers["x-grok-session-id"] === `claude:${rootSession}_agent_task_worker`);

    expect(callParent).toBeDefined();
    expect(callSubagent).toBeDefined();

    expect(callParent[1].headers["x-grok-session-id"]).toBe(`claude:${rootSession}`);
    expect(callSubagent[1].headers["x-grok-session-id"]).toBe(`claude:${rootSession}_agent_task_worker`);
    expect(callParent[1].headers["x-grok-conv-id"]).toBe(`claude:${rootSession}`);
    expect(callSubagent[1].headers["x-grok-conv-id"]).toBe(`claude:${rootSession}_agent_task_worker`);
  });
});
