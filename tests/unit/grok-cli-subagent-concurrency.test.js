import { describe, expect, it, vi, beforeEach } from "vitest";
import { GrokCliExecutor, _resetGrokCliTurnStore } from "../../open-sse/executors/grok-cli.js";
import { resolveSessionId } from "../../open-sse/utils/sessionManager.js";

describe("Grok-CLI Subagent Concurrency & Isolation", () => {
  beforeEach(() => {
    _resetGrokCliTurnStore();
  });

  it("subagents get distinct session IDs under scope=grok-cli", () => {
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

    const parentSess = resolveSessionId({ body: parentBody, scope: "grok-cli" });
    const sub1Sess = resolveSessionId({ body: sub1Body, scope: "grok-cli" });
    const sub2Sess = resolveSessionId({ body: sub2Body, scope: "grok-cli" });

    expect(parentSess).toBe(`claude:${rootSession}`);
    expect(sub1Sess).toBe(`claude:${rootSession}_agent_task_alpha`);
    expect(sub2Sess).toBe(`claude:${rootSession}_subagent_beta_99`);

    expect(sub1Sess).not.toBe(parentSess);
    expect(sub2Sess).not.toBe(parentSess);
    expect(sub1Sess).not.toBe(sub2Sess);
  });

  it("concurrent requests sharing one GrokCliExecutor instance do not cross-pollute headers", async () => {
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

    let capturedArgsA = null;
    let capturedArgsB = null;

    vi.spyOn(Object.getPrototypeOf(GrokCliExecutor.prototype), "execute").mockImplementation(async (args) => {
      if (args.body.session_id === "session-AAA") {
        capturedArgsA = args;
      } else {
        capturedArgsB = args;
      }
      return { response: new Response("data: {}\n\n", { status: 200 }) };
    });

    await Promise.all([
      executor.execute({ model: "grok-4", body: bodyA, stream: true, credentials: sharedBaseCreds }),
      executor.execute({ model: "grok-4.5", body: bodyB, stream: true, credentials: sharedBaseCreds }),
    ]);

    // Base shared credentials must remain unpolluted
    expect(sharedBaseCreds._currentSessionId).toBeUndefined();
    expect(sharedBaseCreds._currentReqId).toBeUndefined();
    expect(sharedBaseCreds._currentTurnIdx).toBeUndefined();

    // Request A assertions
    expect(capturedArgsA.credentials._currentSessionId).toBe("session-AAA");
    expect(capturedArgsA.credentials._currentModel).toBe("grok-4");
    expect(capturedArgsA.credentials._currentTurnIdx).toBe(1);
    const headersA = executor.buildHeaders(capturedArgsA.credentials);
    expect(headersA["x-grok-session-id"]).toBe("session-AAA");
    expect(headersA["x-grok-conv-id"]).toBe("session-AAA");
    expect(headersA["x-grok-model-override"]).toBe("grok-4");
    expect(headersA["x-grok-turn-idx"]).toBe("1");
    expect(headersA["x-grok-req-id"]).toBe(capturedArgsA.credentials._currentReqId);

    // Request B assertions
    expect(capturedArgsB.credentials._currentSessionId).toBe("session-BBB");
    expect(capturedArgsB.credentials._currentModel).toBe("grok-4.5");
    expect(capturedArgsB.credentials._currentTurnIdx).toBe(2);
    const headersB = executor.buildHeaders(capturedArgsB.credentials);
    expect(headersB["x-grok-session-id"]).toBe("session-BBB");
    expect(headersB["x-grok-conv-id"]).toBe("session-BBB");
    expect(headersB["x-grok-model-override"]).toBe("grok-4.5");
    expect(headersB["x-grok-turn-idx"]).toBe("2");
    expect(headersB["x-grok-req-id"]).toBe(capturedArgsB.credentials._currentReqId);

    // Request IDs must be completely unique
    expect(headersA["x-grok-req-id"]).not.toBe(headersB["x-grok-req-id"]);
  });
});
