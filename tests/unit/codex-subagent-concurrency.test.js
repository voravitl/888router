import { describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { resolveSessionId } from "../../open-sse/utils/sessionManager.js";

describe("Codex Subagent Concurrency & Prompt Cache Stability", () => {
  describe("Subagent Session & Prompt Cache Key Stability", () => {
    it("subagents inheriting parent Claude Code session share root session ID and prompt_cache_key", () => {
      const rootSession = "12345678-1234-1234-1234-123456789abc";

      // Subagent 1 payload
      const subagent1Body = {
        metadata: { user_id: `user_device123_session_${rootSession}_agent_task_1` },
        messages: [{ role: "user", content: "Subtask 1: scan directory" }],
      };
      // Subagent 2 payload
      const subagent2Body = {
        metadata: { user_id: `user_device123_session_${rootSession}_subagent_55a20af1` },
        messages: [{ role: "user", content: "Subtask 2: analyze dependencies" }],
      };

      const sess1 = resolveSessionId({ body: subagent1Body, scope: "codex" });
      const sess2 = resolveSessionId({ body: subagent2Body, scope: "codex" });

      expect(sess1).toBe(`claude:${rootSession}`);
      expect(sess2).toBe(`claude:${rootSession}`);
      expect(sess1).toBe(sess2);
    });

    it("x-client-request-id header does NOT overwrite stable body session or prompt_cache_key", () => {
      const bodyWithPromptCacheKey = {
        prompt_cache_key: "shared-agent-workspace-key-xyz",
        messages: [{ role: "user", content: "Check codebase status" }],
      };

      // Client sends a fresh unique x-client-request-id on each turn
      const turn1Headers = { "x-client-request-id": "req-uuid-turn-1" };
      const turn2Headers = { "x-client-request-id": "req-uuid-turn-2" };

      const sess1 = resolveSessionId({ headers: turn1Headers, body: bodyWithPromptCacheKey, scope: "codex" });
      const sess2 = resolveSessionId({ headers: turn2Headers, body: bodyWithPromptCacheKey, scope: "codex" });

      // Must be stable and equal to the body prompt_cache_key, not turn-specific request IDs
      expect(sess1).toBe("shared-agent-workspace-key-xyz");
      expect(sess2).toBe("shared-agent-workspace-key-xyz");
      expect(sess1).toBe(sess2);
    });

    it("preserves x-client-request-id as fallback when caller has no other session id (non-kiro/non-claude)", () => {
      const emptyBody = { messages: [{ role: "user", content: "Hello" }] };
      const headers = { "x-client-request-id": "client-fallback-session-999" };
      const sess = resolveSessionId({ headers, body: emptyBody, scope: "openai" });
      expect(sess).toBe("client-fallback-session-999");
    });

    it("subagents without session headers but sharing parent assistant history get matching session IDs via assistantTextSessionId", () => {
      const sharedAssistantText = "I will help you implement the feature by breaking it into two subagents. Let's start with analysis.".repeat(2);
      const subagent1Body = {
        messages: [
          { role: "user", content: "Original task" },
          { role: "assistant", content: sharedAssistantText },
          { role: "user", content: "Subagent 1: read file A" },
        ],
      };
      const subagent2Body = {
        messages: [
          { role: "user", content: "Original task" },
          { role: "assistant", content: sharedAssistantText },
          { role: "user", content: "Subagent 2: read file B" },
        ],
      };

      const sess1 = resolveSessionId({ body: subagent1Body, connectionId: "conn-shared", scope: "codex" });
      const sess2 = resolveSessionId({ body: subagent2Body, connectionId: "conn-shared", scope: "codex" });

      expect(sess1).toBeDefined();
      expect(sess1).toBe(sess2);
    });
  });

  describe("CodexExecutor Concurrent Isolation", () => {
    it("concurrent requests sharing one executor and shared credentials object do not cross-pollute", async () => {
      const executor = new CodexExecutor();
      const sharedBaseCreds = {
        connectionId: "shared-conn",
        providerSpecificData: { workspaceId: "ws-123" },
      };

      const bodyA = {
        model: "gpt-5.3-codex",
        session_id: "session-AAA",
        input: [{ role: "user", content: "Task A" }],
        _compact: true,
      };
      const bodyB = {
        model: "gpt-5.3-codex",
        session_id: "session-BBB",
        input: [{ role: "user", content: "Task B" }],
      };

      let capturedArgsA = null;
      let capturedArgsB = null;

      vi.spyOn(Object.getPrototypeOf(CodexExecutor.prototype), "execute").mockImplementation(async (args) => {
        if (args.body.session_id === "session-AAA") {
          capturedArgsA = args;
        } else {
          capturedArgsB = args;
        }
        return { response: new Response("data: {}\n\n", { status: 200 }) };
      });

      // Run concurrent executes with the exact same shared credentials object
      await Promise.all([
        executor.execute({ model: "gpt-5.3-codex", body: bodyA, stream: true, credentials: sharedBaseCreds }),
        executor.execute({ model: "gpt-5.3-codex", body: bodyB, stream: true, credentials: sharedBaseCreds }),
      ]);

      // Base shared credentials must remain unpolluted
      expect(sharedBaseCreds._currentSessionId).toBeUndefined();
      expect(sharedBaseCreds._isCompact).toBeUndefined();

      // Scoped credentials for request A
      expect(capturedArgsA.credentials._currentSessionId).toBe("session-AAA");
      expect(capturedArgsA.credentials._isCompact).toBe(true);
      expect(executor.buildHeaders(capturedArgsA.credentials)["session_id"]).toBe("session-AAA");
      expect(executor.buildUrl("gpt-5.3-codex", true, 0, capturedArgsA.credentials)).toContain("/compact");

      // Scoped credentials for request B
      expect(capturedArgsB.credentials._currentSessionId).toBe("session-BBB");
      expect(capturedArgsB.credentials._isCompact).toBe(false);
      expect(executor.buildHeaders(capturedArgsB.credentials)["session_id"]).toBe("session-BBB");
      expect(executor.buildUrl("gpt-5.3-codex", true, 0, capturedArgsB.credentials)).not.toContain("/compact");
    });

    it("prefetchImages returns immediately when no image_url exists without mutating content", async () => {
      const executor = new CodexExecutor();
      const body = {
        input: [
          { role: "user", content: [{ type: "input_text", text: "Pure text prompt" }] },
        ],
      };

      const t0 = Date.now();
      await executor.prefetchImages(body);
      expect(Date.now() - t0).toBeLessThan(50);
      expect(body.input[0].content[0].type).toBe("input_text");
    });
  });
});
