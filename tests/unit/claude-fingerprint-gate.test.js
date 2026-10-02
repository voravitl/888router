// Claude CLI fingerprint gate — Anthropic gates new models (opus-5-5, fable-5-1,
// sonnet-5-5, opus-4-6, sonnet-4-6) behind a minimum Claude Code client version.
// A stale advertised fingerprint gets a live 400 on those models.
// Cf. upstream OpenClaw issue #157250 (stale ANTHROPIC_CLAUDE_CODE_VERSION, same 400).
import { describe, it, expect } from "vitest";
import { CLAUDE_CLI_VERSION, CLAUDE_CLI_SPOOF_HEADERS } from "../../open-sse/providers/shared.js";
import claudeConfig from "../../open-sse/providers/registry/claude.js";

// Known Anthropic minimum for the opus-5-5 / fable-5-1 class models.
const MIN_CLI_VERSION = "2.1.280";

function parse(v) {
  return String(v).split(".").map((n) => parseInt(n, 10));
}

function gte(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

describe("claude fingerprint gate", () => {
  it("advertised CLAUDE_CLI_VERSION meets the Anthropic model-serving floor", () => {
    expect(gte(CLAUDE_CLI_VERSION, MIN_CLI_VERSION)).toBe(true);
  });

  it("registry User-Agent tracks CLAUDE_CLI_VERSION (no drift)", () => {
    expect(claudeConfig.transport.headers["User-Agent"]).toBe(
      `claude-cli/${CLAUDE_CLI_VERSION} (external, sdk-cli)`
    );
  });

  it("spoof headers User-Agent tracks CLAUDE_CLI_VERSION (no drift)", () => {
    expect(CLAUDE_CLI_SPOOF_HEADERS["User-Agent"]).toBe(
      `claude-cli/${CLAUDE_CLI_VERSION} (external, sdk-cli)`
    );
  });

  it("registry serves gated new models only with a passing fingerprint", () => {
    const gated = ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-opus-4-6", "claude-sonnet-4-6"];
    const ids = claudeConfig.models.map((m) => m.id);
    for (const id of gated) {
      expect(ids).toContain(id);
    }
    expect(gte(CLAUDE_CLI_VERSION, MIN_CLI_VERSION)).toBe(true);
  });
});
