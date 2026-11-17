import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("Optimized Thai Simple output style", () => {
  describe("unit rules (open-sse/rtk/thaiSimple.js)", () => {
    it("exports clean modes and a compact, non-gender-locked, cache-safe Thai Simple prompt", async () => {
      const { THAI_SIMPLE_MODES, THAI_SIMPLE_PROMPT, normalizeThaiSimpleMode } =
        await import("../../open-sse/rtk/thaiSimple.js");

      expect(THAI_SIMPLE_MODES).toEqual({ OFF: "off", AUTO: "auto", ALL: "all" });
      expect(normalizeThaiSimpleMode("AUTO")).toBe("auto");
      expect(normalizeThaiSimpleMode("all")).toBe("all");
      expect(normalizeThaiSimpleMode("invalid")).toBe("off");

      // Core Thai Simple structure & optimizations
      expect(THAI_SIMPLE_PROMPT).toMatch(/Thai/i);
      expect(THAI_SIMPLE_PROMPT).toMatch(/first sentence|answer first/i);
      expect(THAI_SIMPLE_PROMPT).toMatch(/table|diagram/i);
      expect(THAI_SIMPLE_PROMPT).toMatch(/exact|identifiers|paths/i);
      expect(THAI_SIMPLE_PROMPT).toMatch(/Chinese|language drift/i);
      // Must NOT hardcode male particle ("ครับ") so female/neutral personas stay safe
      expect(THAI_SIMPLE_PROMPT).not.toContain("ครับ");
      // Compact enough to stay cheap in system prefix
      expect(THAI_SIMPLE_PROMPT.length).toBeLessThan(1200);
    });

    it("gates injection across modes, Hermes, Claude Code, JSON schema, low max_tokens, existing Thai rules, and header overrides", async () => {
      const { injectThaiSimple, THAI_SIMPLE_PROMPT } =
        await import("../../open-sse/rtk/thaiSimple.js");

      const baseBody = () => ({
        model: "deepseek-v4.1-flash",
        messages: [{ role: "user", content: "อธิบาย cache หน่อย" }],
      });

      // mode=off: skips normally
      const offBody = baseBody();
      expect(injectThaiSimple(offBody, "openai", { mode: "off", clientTool: null })).toBe(false);
      expect(offBody.messages[0].role).toBe("user");

      // mode=auto: injects for OpenCode / Web Chat / bare SDKs
      const autoBody = baseBody();
      expect(injectThaiSimple(autoBody, "openai", { mode: "auto", clientTool: "opencode" })).toBe(true);
      expect(autoBody.messages[0].role).toBe("system");
      expect(autoBody.messages[0].content).toContain(THAI_SIMPLE_PROMPT);

      // Idempotent if called again on same body
      expect(injectThaiSimple(autoBody, "openai", { mode: "auto", clientTool: "opencode" })).toBe(false);
      expect(autoBody.messages.filter((m) => m.role === "system")).toHaveLength(1);

      // mode=auto: skips Hermes by default (Hermes owns SOUL.md + thai-communication)
      const hermesAuto = baseBody();
      expect(injectThaiSimple(hermesAuto, "openai", { mode: "auto", clientTool: "hermes" })).toBe(false);

      // mode=all: applies to Hermes when no duplicate Thai rule exists
      const hermesAll = baseBody();
      expect(injectThaiSimple(hermesAll, "openai", { mode: "all", clientTool: "hermes" })).toBe(true);
      expect(hermesAll.messages[0].content).toContain(THAI_SIMPLE_PROMPT);

      // mode=all: STILL protects Claude Code passthrough
      const claudeBody = { system: "claude prompt", messages: [{ role: "user", content: "hi" }] };
      expect(injectThaiSimple(claudeBody, "claude", {
        mode: "all",
        clientTool: "claude",
        preserveClaudeClientInput: true,
      })).toBe(false);
      expect(claudeBody.system).toBe("claude prompt");

      // Skips structured JSON / json_schema responses
      const jsonBody = { ...baseBody(), response_format: { type: "json_schema", json_schema: { name: "x" } } };
      expect(injectThaiSimple(jsonBody, "openai", { mode: "all", clientTool: null })).toBe(false);

      const geminiJson = {
        contents: [{ role: "user", parts: [{ text: "return json" }] }],
        generationConfig: { responseMimeType: "application/json" },
      };
      expect(injectThaiSimple(geminiJson, "gemini", { mode: "all", clientTool: null })).toBe(false);

      // Skips micro classifier / probe requests (max_tokens <= 64)
      const probeBody = { ...baseBody(), max_tokens: 32 };
      expect(injectThaiSimple(probeBody, "openai", { mode: "all", clientTool: null })).toBe(false);

      // Skips when system prompt already carries Thai style / SOUL / thai-communication rules
      const soulBody = {
        messages: [
          { role: "system", content: "Load and follow thai-communication for Thai replies." },
          { role: "user", content: "สวัสดี" },
        ],
      };
      expect(injectThaiSimple(soulBody, "openai", { mode: "all", clientTool: "hermes" })).toBe(false);

      // Header overrides: off blocks even mode=all; thai-simple enables even mode=off
      const headerOff = baseBody();
      expect(injectThaiSimple(headerOff, "openai", {
        mode: "all",
        headers: { "x-888-output-style": "off" },
      })).toBe(false);

      const headerOn = baseBody();
      expect(injectThaiSimple(headerOn, "openai", {
        mode: "off",
        headers: { "x-888-output-style": "thai-simple" },
      })).toBe(true);
      expect(headerOn.messages[0].content).toContain(THAI_SIMPLE_PROMPT);
    });
  });

  describe("handleChatCore integration (past 100k cache stability & JSON safety)", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it("injects Thai Simple consistently past 100k tokens for bare OpenAI callers while keeping Claude passthrough untouched", async () => {
      const executeMock = vi.fn(async () => ({
        response: new Response(JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
        }), { status: 200, headers: { "content-type": "application/json" } }),
        url: "https://api.openai.com/v1/chat/completions",
        headers: {},
      }));

      vi.doMock("../../open-sse/executors/index.js", () => ({
        getExecutor: () => ({ noAuth: true, execute: executeMock }),
      }));
      vi.doMock("../../open-sse/utils/requestLogger.js", () => ({
        createRequestLogger: async () => ({
          logClientRawRequest: vi.fn(),
          logRawRequest: vi.fn(),
          logTargetRequest: vi.fn(),
          logProviderResponse: vi.fn(),
          logConvertedResponse: vi.fn(),
          logError: vi.fn(),
        }),
      }));
      vi.doMock("../../open-sse/utils/stream.js", () => ({
        COLORS: { red: "", reset: "" },
        createSSETransformStreamWithLogger: vi.fn(() => new TransformStream()),
        createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
        createClaudeNativeStreamWithLogger: vi.fn(() => new TransformStream()),
      }));
      vi.doMock("@/lib/usageDb.js", () => ({
        trackPendingRequest: vi.fn(),
        appendRequestLog: vi.fn(async () => {}),
        saveRequestDetail: vi.fn(async () => {}),
        saveRequestUsage: vi.fn(async () => {}),
      }));

      const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
      const { THAI_SIMPLE_PROMPT } = await import("../../open-sse/rtk/thaiSimple.js");

      // Large OpenAI history (>100k tokens) with thaiSimpleMode="auto" keeps prefix consistent
      const hugeText = "context line ".repeat(110000);
      await handleChatCore({
        body: {
          model: "gpt-4o",
          stream: false,
          messages: [
            { role: "system", content: "Base system prompt" },
            { role: "user", content: hugeText },
          ],
        },
        modelInfo: { provider: "openai", model: "gpt-4o" },
        credentials: { apiKey: "test" },
        thaiSimpleMode: "auto",
        sourceFormatOverride: "openai",
        clientRawRequest: { headers: {}, body: {} },
      });

      const sentMsgs = executeMock.mock.calls[0][0].body.messages;
      expect(sentMsgs[0].role).toBe("system");
      expect(sentMsgs[0].content).toContain("Base system prompt");
      expect(sentMsgs[0].content).toContain(THAI_SIMPLE_PROMPT);
    });

    it("chat.js forwards thaiSimpleMode and does not forward retired cavemanEnabled to handleChatCore", async () => {
      const handleChatCoreMock = vi.fn(async () => ({
        success: true,
        response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
      }));
      vi.doMock("@/lib/localDb", () => ({
        getSettings: vi.fn(async () => ({
          requireApiKey: false,
          thaiSimpleMode: "auto",
          cavemanEnabled: true,
        })),
        updateProviderConnection: vi.fn(async () => {}),
        getProviderConnections: vi.fn(async () => []),
      }));
      vi.doMock("open-sse/handlers/chatCore.js", () => ({
        handleChatCore: handleChatCoreMock,
      }));
      vi.doMock("../../src/sse/services/model.js", () => ({
        getModelInfo: vi.fn(async () => ({ provider: "openai", model: "gpt-4o" })),
        getComboModels: vi.fn(async () => null),
        applyThinkingSuffixToMembers: (m) => m,
      }));
      vi.doMock("../../src/sse/services/auth.js", () => ({
        getProviderCredentials: vi.fn(async () => ({
          connectionId: "conn-1",
          connectionName: "openai-1",
          apiKey: "sk-test",
          providerSpecificData: {},
        })),
        markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
        clearAccountError: vi.fn(async () => {}),
        extractApiKey: vi.fn(() => null),
        isValidApiKey: vi.fn(async () => true),
      }));
      vi.doMock("../../src/sse/services/tokenRefresh.js", () => ({
        updateProviderCredentials: vi.fn(async () => {}),
        checkAndRefreshToken: vi.fn(async (_p, c) => c),
      }));
      vi.doMock("../../src/sse/services/modelContext.js", () => ({
        ensureModelContextLoaded: vi.fn(async () => {}),
      }));
      vi.doMock("../../src/sse/services/providerQuota.js", () => ({
        clearProviderStrikes: vi.fn(),
        handleProviderQuotaError: vi.fn(async () => null),
        isQuotaTrackedProvider: vi.fn(() => false),
      }));

      try {
        const { handleChat } = await import("../../src/sse/handlers/chat.js");
        const res = await handleChat(new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
        }));
        expect(res.status).toBe(200);
        expect(handleChatCoreMock).toHaveBeenCalledOnce();
        const coreOpts = handleChatCoreMock.mock.calls[0][0];
        expect(coreOpts.thaiSimpleMode).toBe("auto");
        expect(coreOpts.cavemanEnabled).toBeUndefined();
        expect(coreOpts.cavemanLevel).toBeUndefined();
      } finally {
        vi.doUnmock("@/lib/localDb");
        vi.doUnmock("open-sse/handlers/chatCore.js");
        vi.doUnmock("../../src/sse/services/model.js");
        vi.doUnmock("../../src/sse/services/auth.js");
        vi.doUnmock("../../src/sse/services/tokenRefresh.js");
        vi.doUnmock("../../src/sse/services/modelContext.js");
        vi.doUnmock("../../src/sse/services/providerQuota.js");
      }
    });
  });

  describe("settingsRepo & /api/settings contract", () => {
    const originalDataDir = process.env.DATA_DIR;
    let tempDir;

    afterAll(() => {
      try { global._dbAdapter?.instance?.close?.(); } catch {}
      delete global._dbAdapter;
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
    });

    it("defaults thaiSimpleMode to 'off', removes caveman defaults, and validates PATCH /api/settings", async () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "thai-simple-settings-"));
      process.env.DATA_DIR = tempDir;
      try { global._dbAdapter?.instance?.close?.(); } catch {}
      delete global._dbAdapter;
      vi.resetModules();

      const db = await import("../../src/lib/db/index.js");
      await db.initDb();
      const defaults = await db.getSettings();
      expect(defaults.thaiSimpleMode).toBe("off");
      expect(defaults.cavemanEnabled).toBeUndefined();
      expect(defaults.cavemanLevel).toBeUndefined();

      const { GET, PATCH } = await import("../../src/app/api/settings/route.js");
      const getRes = await GET();
      const getJson = await getRes.json();
      expect(getJson.thaiSimpleMode).toBe("off");

      const badRes = await PATCH(new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thaiSimpleMode: "invalid-mode" }),
      }));
      expect(badRes.status).toBe(400);

      const okRes = await PATCH(new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thaiSimpleMode: "auto" }),
      }));
      expect(okRes.status).toBe(200);
      expect((await okRes.json()).thaiSimpleMode).toBe("auto");
    });
  });
});
