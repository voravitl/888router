// Anthropic refuses the Claude Code identity line on API-key traffic.
//
// Live-verified 2026-10-19 against api.anthropic.com with an sk-ant-usr key:
//   system: [{text: "<identity>"}]                          → 400 credit balance
//   system: [{text: "<identity without trailing period>"}]  → 200
//   system: [{text: "lorem ipsum <identity> dolor"}]        → 200
//   no system / empty system                                → 200
// So the identity must never reach an official Anthropic endpoint authenticated
// with an API key, while the OAuth (subscription) path keeps it.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import {
  CLAUDE_CODE_IDENTITY,
  stripClaudeCodeIdentity,
  stripClaudeCodeIdentityFromBody,
  isClaudeOAuthCredential,
} from "../../open-sse/translator/concerns/claudeCodeIdentity.js";

const API_KEY = { apiKey: "sk-ant-usr-not-a-real-key" };
const OAUTH = { accessToken: "sk-ant-oat01-not-a-real-token" };

const toClaude = (body, creds, provider) =>
  translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "claude-sonnet-5-5", body, false, creds, provider);

const systemTexts = (out) => (out.system || []).map((b) => String(b?.text ?? ""));

describe("claudeCodeIdentity helpers", () => {
  it("blanks a block that is exactly the identity line", () => {
    expect(stripClaudeCodeIdentity(CLAUDE_CODE_IDENTITY)).toBe("");
    expect(stripClaudeCodeIdentity(`  ${CLAUDE_CODE_IDENTITY}  `)).toBe("");
  });

  it("keeps other text intact", () => {
    expect(stripClaudeCodeIdentity("You are a helpful assistant.")).toBe("You are a helpful assistant.");
  });

  it("rewrites an embedded identity and keeps the surrounding text", () => {
    const out = stripClaudeCodeIdentity(`${CLAUDE_CODE_IDENTITY} Be brief.`);
    expect(out).not.toContain("official CLI for Claude");
    expect(out).toContain("Be brief.");
  });

  it("detects OAuth credentials only", () => {
    expect(isClaudeOAuthCredential("sk-ant-oat01-x")).toBe(true);
    expect(isClaudeOAuthCredential("sk-ant-usr-x")).toBe(false);
    expect(isClaudeOAuthCredential(undefined)).toBe(false);
  });

  it("deletes an emptied system field instead of leaving an empty array", () => {
    const body = { system: [{ type: "text", text: CLAUDE_CODE_IDENTITY }] };
    stripClaudeCodeIdentityFromBody(body);
    expect(body.system).toBeUndefined();
  });
});

describe("OpenAI → Claude: identity injection is OAuth-only (#anthropic-apikey)", () => {
  it("does not inject the identity for the anthropic provider (API key)", () => {
    const out = toClaude({ messages: [{ role: "user", content: "hi" }] }, API_KEY, "anthropic");
    expect(systemTexts(out).some((t) => t.includes("official CLI for Claude"))).toBe(false);
  });

  it("injects the identity for the claude provider (OAuth)", () => {
    const out = toClaude({ messages: [{ role: "user", content: "hi" }] }, OAUTH, "claude");
    expect(systemTexts(out)).toContain(CLAUDE_CODE_IDENTITY);
  });

  it("does not inject for an anthropic-compatible provider", () => {
    const out = toClaude({ messages: [{ role: "user", content: "hi" }] }, API_KEY, "anthropic-compatible-x");
    expect(systemTexts(out).some((t) => t.includes("official CLI for Claude"))).toBe(false);
  });
});

describe("Claude body: client-sent identity is neutralized on API-key traffic", () => {
  it("strips a client-sent identity block for the anthropic provider", () => {
    const out = toClaude(
      { messages: [{ role: "system", content: CLAUDE_CODE_IDENTITY }, { role: "user", content: "hi" }] },
      API_KEY,
      "anthropic",
    );
    expect(systemTexts(out).some((t) => t.includes("official CLI for Claude"))).toBe(false);
  });

  it("strips the identity from an OpenAI→Claude body for the anthropic provider", () => {
    const out = toClaude(
      { messages: [{ role: "system", content: `${CLAUDE_CODE_IDENTITY} Be brief.` }, { role: "user", content: "hi" }] },
      API_KEY,
      "anthropic",
    );
    const joined = systemTexts(out).join("\n");
    expect(joined).not.toContain("official CLI for Claude");
    expect(joined).toContain("Be brief.");
  });

  it("keeps a client-sent identity for the OAuth claude provider", () => {
    const out = toClaude(
      { messages: [{ role: "system", content: CLAUDE_CODE_IDENTITY }, { role: "user", content: "hi" }] },
      OAUTH,
      "claude",
    );
    expect(systemTexts(out)).toContain(CLAUDE_CODE_IDENTITY);
  });

  it("strips the identity on a Claude→Claude passthrough for the anthropic provider", () => {
    const body = {
      model: "claude-sonnet-5-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
      system: [{ type: "text", text: CLAUDE_CODE_IDENTITY, cache_control: { type: "ephemeral" } }],
    };
    const out = translateRequest(
      FORMATS.CLAUDE, FORMATS.CLAUDE, "claude-sonnet-5-5", structuredClone(body), false, API_KEY, "anthropic",
    );
    expect(systemTexts(out).some((t) => t.includes("official CLI for Claude"))).toBe(false);
  });
});
