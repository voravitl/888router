import { describe, expect, it, vi } from "vitest";
import { AntigravityExecutor, sanitizeAntigravityPrompt } from "../../open-sse/executors/antigravity.js";
import { resolveSessionId, toNumericSessionId } from "../../open-sse/utils/sessionManager.js";

describe("Antigravity Subagent Concurrency & Prompt Sanitization", () => {
  describe("Subagent Session Isolation", () => {
    it("subagents get distinct session IDs under scope=antigravity", () => {
      const rootSession = "12345678-1234-1234-1234-123456789abc";

      const parentBody = {
        metadata: { user_id: `user_device123_session_${rootSession}` },
        messages: [{ role: "user", content: "Parent task" }],
      };
      const subagent1Body = {
        metadata: { user_id: `user_device123_session_${rootSession}_agent_task_1` },
        messages: [{ role: "user", content: "Subtask 1" }],
      };
      const subagent2Body = {
        metadata: { user_id: `user_device123_session_${rootSession}_subagent_55a20af1` },
        messages: [{ role: "user", content: "Subtask 2" }],
      };

      const parentSess = resolveSessionId({ body: parentBody, scope: "antigravity" });
      const sub1Sess = resolveSessionId({ body: subagent1Body, scope: "antigravity" });
      const sub2Sess = resolveSessionId({ body: subagent2Body, scope: "antigravity" });

      expect(parentSess).toBe(`claude:${rootSession}`);
      expect(sub1Sess).toBe(`claude:${rootSession}_agent_task_1`);
      expect(sub2Sess).toBe(`claude:${rootSession}_subagent_55a20af1`);

      // Numeric session IDs sent to Google Cloud Code must be distinct
      const parentNum = toNumericSessionId(parentSess);
      const sub1Num = toNumericSessionId(sub1Sess);
      const sub2Num = toNumericSessionId(sub2Sess);

      expect(parentNum).toMatch(/^-\d+$/);
      expect(sub1Num).toMatch(/^-\d+$/);
      expect(sub2Num).toMatch(/^-\d+$/);

      expect(sub1Num).not.toBe(parentNum);
      expect(sub2Num).not.toBe(parentNum);
      expect(sub1Num).not.toBe(sub2Num);
    });
  });

  describe("AntigravityExecutor Concurrency Isolation", () => {
    it("concurrent requests sharing one AntigravityExecutor instance do not cross-pollute session headers", async () => {
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

      let capturedArgsA = null;
      let capturedArgsB = null;

      vi.spyOn(Object.getPrototypeOf(AntigravityExecutor.prototype), "execute").mockImplementation(async (args) => {
        if (args.body.request.sessionId === "-111111111111111") {
          capturedArgsA = args;
        } else {
          capturedArgsB = args;
        }
        return { response: new Response("data: {}\n\n", { status: 200 }) };
      });

      await Promise.all([
        executor.execute({ model: "gemini-2.5-flash", body: bodyA, stream: true, credentials: sharedBaseCreds }),
        executor.execute({ model: "gemini-2.5-flash", body: bodyB, stream: true, credentials: sharedBaseCreds }),
      ]);

      // Base shared credentials must remain unpolluted
      expect(sharedBaseCreds._currentSessionId).toBeUndefined();

      // Scoped credentials for request A
      expect(capturedArgsA.credentials._currentSessionId).toBe("-111111111111111");
      const headersA = executor.buildHeaders(capturedArgsA.credentials);
      expect(headersA["X-Machine-Session-Id"]).toBe("-111111111111111");

      // Scoped credentials for request B
      expect(capturedArgsB.credentials._currentSessionId).toBe("-222222222222222");
      const headersB = executor.buildHeaders(capturedArgsB.credentials);
      expect(headersB["X-Machine-Session-Id"]).toBe("-222222222222222");
    });
  });

  describe("Competitive Prompt Sanitization", () => {
    it("sanitizes Claude Code and Zed prompts without altering user instruction", () => {
      const claudeCodePrompt = "You are Claude Code, Anthropic's official CLI for Claude. Solve the user task.";
      const sanitized = sanitizeAntigravityPrompt(claudeCodePrompt);
      expect(sanitized).not.toContain("Anthropic's official CLI for Claude");
      expect(sanitized).toBe("You are a helpful programming assistant. Solve the user task.");

      const zedPrompt = "You are a Claude agent, built on Anthropic's Claude Agent SDK. Write code.";
      expect(sanitizeAntigravityPrompt(zedPrompt)).toBe(" Write code.");

      const normalPrompt = "Explain how quicksort works in Rust.";
      expect(sanitizeAntigravityPrompt(normalPrompt)).toBe(normalPrompt);
    });
  });
});
