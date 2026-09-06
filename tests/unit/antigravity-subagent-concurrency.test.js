import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

import { AntigravityExecutor, sanitizeAntigravityPrompt } from "../../open-sse/executors/antigravity.js";
import { resolveSessionId, toNumericSessionId } from "../../open-sse/utils/sessionManager.js";
import { translateRequest } from "../../open-sse/translator/index.js";

describe("Antigravity Subagent Concurrency & Prompt Sanitization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyAwareFetch.mockResolvedValue(
      new Response("data: {}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    );
  });

  describe("Subagent Session Isolation", () => {
    it("subagents get distinct session IDs under scope=antigravity (agent, subagent, task, sidecar)", () => {
      const rootSession = "12345678-1234-1234-1234-123456789abc";

      const parentBody = {
        metadata: { user_id: `user_device123_session_${rootSession}` },
        messages: [{ role: "user", content: "Parent task" }],
      };
      const sub1Body = {
        metadata: { user_id: `user_device123_session_${rootSession}_agent_task_1` },
        messages: [{ role: "user", content: "Subtask 1" }],
      };
      const sub2Body = {
        metadata: { user_id: `user_device123_session_${rootSession}_subagent_55a20af1` },
        messages: [{ role: "user", content: "Subtask 2" }],
      };
      const sub3Body = {
        metadata: { user_id: `user_device123_session_${rootSession}_task-subplan-1` },
        messages: [{ role: "user", content: "Subtask 3" }],
      };

      const parentSess = resolveSessionId({ body: parentBody, scope: "antigravity" });
      const sub1Sess = resolveSessionId({ body: sub1Body, scope: "antigravity" });
      const sub2Sess = resolveSessionId({ body: sub2Body, scope: "antigravity" });
      const sub3Sess = resolveSessionId({ body: sub3Body, scope: "antigravity" });

      expect(parentSess).toBe(`claude:${rootSession}`);
      expect(sub1Sess).toBe(`claude:${rootSession}_agent_task_1`);
      expect(sub2Sess).toBe(`claude:${rootSession}_subagent_55a20af1`);
      expect(sub3Sess).toBe(`claude:${rootSession}_task-subplan-1`);

      // Numeric session IDs sent to Google Cloud Code must be distinct
      const parentNum = toNumericSessionId(parentSess);
      const sub1Num = toNumericSessionId(sub1Sess);
      const sub2Num = toNumericSessionId(sub2Sess);
      const sub3Num = toNumericSessionId(sub3Sess);

      expect(parentNum).toMatch(/^-\d+$/);
      expect(sub1Num).toMatch(/^-\d+$/);
      expect(sub2Num).toMatch(/^-\d+$/);
      expect(sub3Num).toMatch(/^-\d+$/);

      expect(sub1Num).not.toBe(parentNum);
      expect(sub2Num).not.toBe(parentNum);
      expect(sub3Num).not.toBe(parentNum);
      expect(sub1Num).not.toBe(sub2Num);
      expect(sub1Num).not.toBe(sub3Num);
    });
  });

  describe("AntigravityExecutor Concurrency & Pipeline Real Execution", () => {
    it("concurrent requests sharing one AntigravityExecutor instance send correct headers to proxyAwareFetch without race", async () => {
      const executor = new AntigravityExecutor();
      const sharedBaseCreds = {
        accessToken: "test-token",
        email: "test@example.com",
      };

      const bodyA = {
        model: "gemini-2.5-flash",
        request: {
          sessionId: "-111111111111111",
          contents: [{ role: "user", parts: [{ text: "Task A" }] }],
        },
      };
      const bodyB = {
        model: "gemini-2.5-flash",
        request: {
          sessionId: "-222222222222222",
          contents: [{ role: "user", parts: [{ text: "Task B" }] }],
        },
      };

      await Promise.all([
        executor.execute({ model: "gemini-2.5-flash", body: bodyA, stream: true, credentials: sharedBaseCreds }),
        executor.execute({ model: "gemini-2.5-flash", body: bodyB, stream: true, credentials: sharedBaseCreds }),
      ]);

      // Base shared credentials must remain unpolluted
      expect(sharedBaseCreds._currentSessionId).toBeUndefined();

      expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(2);

      const callA = mocks.proxyAwareFetch.mock.calls.find((c) => {
        const parsed = JSON.parse(c[1].body);
        return parsed.request?.sessionId === "-111111111111111";
      });
      const callB = mocks.proxyAwareFetch.mock.calls.find((c) => {
        const parsed = JSON.parse(c[1].body);
        return parsed.request?.sessionId === "-222222222222222";
      });

      expect(callA).toBeDefined();
      expect(callB).toBeDefined();

      expect(callA[1].headers["X-Machine-Session-Id"]).toBe("-111111111111111");
      expect(callB[1].headers["X-Machine-Session-Id"]).toBe("-222222222222222");

      // Instance state must not be polluted with last request's session
      expect(executor._lastSessionId).toBeUndefined();
    });

    it("end-to-end: Claude Code request translated and executed isolates parent and subagent", async () => {
      const executor = new AntigravityExecutor();
      const rootSession = "550e8400-e29b-41d4-a716-446655440000";
      const sharedCreds = {
        accessToken: "test-token-ag",
        email: "user@example.com",
      };

      const parentClaudeBody = {
        model: "claude-3-7-sonnet",
        metadata: { user_id: `user_dev_session_${rootSession}` },
        messages: [{ role: "user", content: "Parent prompt" }],
      };
      const subagentClaudeBody = {
        model: "claude-3-7-sonnet",
        metadata: { user_id: `user_dev_session_${rootSession}_agent_task_1` },
        messages: [{ role: "user", content: "Subagent prompt" }],
      };

      const parentReqCreds = Object.assign(Object.create(sharedCreds), {});
      const subagentReqCreds = Object.assign(Object.create(sharedCreds), {});

      const translatedParent = translateRequest("claude", "antigravity", "gemini-2.5-flash", parentClaudeBody, true, parentReqCreds, "antigravity");
      const translatedSubagent = translateRequest("claude", "antigravity", "gemini-2.5-flash", subagentClaudeBody, true, subagentReqCreds, "antigravity");

      expect(parentReqCreds._clientSessionId).toBe(`claude:${rootSession}`);
      expect(subagentReqCreds._clientSessionId).toBe(`claude:${rootSession}_agent_task_1`);

      const parentNumeric = toNumericSessionId(`claude:${rootSession}`);
      const subagentNumeric = toNumericSessionId(`claude:${rootSession}_agent_task_1`);

      expect(translatedParent.request.sessionId).toBe(parentNumeric);
      expect(translatedSubagent.request.sessionId).toBe(subagentNumeric);
      expect(parentNumeric).not.toBe(subagentNumeric);

      await Promise.all([
        executor.execute({ model: "gemini-2.5-flash", body: translatedParent, stream: true, credentials: parentReqCreds }),
        executor.execute({ model: "gemini-2.5-flash", body: translatedSubagent, stream: true, credentials: subagentReqCreds }),
      ]);

      const calls = mocks.proxyAwareFetch.mock.calls;
      const sentHeaders = calls.map((c) => c[1].headers["X-Machine-Session-Id"]);
      expect(sentHeaders).toContain(parentNumeric);
      expect(sentHeaders).toContain(subagentNumeric);
    });
  });

  describe("Competitive Prompt Sanitization", () => {
    it("sanitizes Claude Code and Zed prompts without trailing whitespace or altering user instruction", () => {
      const claudeCodePrompt = "You are Claude Code, Anthropic's official CLI for Claude. Solve the user task.";
      const sanitized = sanitizeAntigravityPrompt(claudeCodePrompt);
      expect(sanitized).not.toContain("Anthropic's official CLI for Claude");
      expect(sanitized).toBe("Solve the user task.");

      const zedPrompt = "You are a Claude agent, built on Anthropic's Claude Agent SDK. Write code.";
      expect(sanitizeAntigravityPrompt(zedPrompt)).toBe("Write code.");

      const normalPrompt = "Explain how quicksort works in Rust.";
      expect(sanitizeAntigravityPrompt(normalPrompt)).toBe(normalPrompt);
    });
  });
});
