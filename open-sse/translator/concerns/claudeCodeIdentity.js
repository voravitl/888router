// Claude Code identity line — an entitlement claim, not an instruction.
//
// Anthropic accepts a request whose `system` carries this exact line only on
// subscription (OAuth / sk-ant-oat) traffic. The SAME line sent with a plain
// API key is refused before any model runs:
//
//   400 invalid_request_error
//   "Your credit balance is too low to access the Anthropic API."
//
// Verified live against api.anthropic.com (2026-10-19) with an sk-ant-usr key:
//   system: [{text: "<identity>"}]                          → 400 credit balance
//   system: [{text: "<identity without trailing period>"}]  → 200
//   system: [{text: "lorem ipsum <identity> dolor"}]        → 200 (embedded is fine)
//   no system                                                → 200
// Dropping the block and rewriting the text both returned 200, so the gate is an
// exact standalone-block match on the identity string.
//
// Consequence for this gateway: an official Anthropic provider authenticated
// with an API key can never carry the identity — neither because we inject it
// (openai→claude bridge) nor because a Claude Code client sends it. API-key
// providers must strip it; OAuth providers must keep it (that path needs it and
// is accepted).
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

// Providers that talk to the official api.anthropic.com endpoint.
export const OFFICIAL_ANTHROPIC_PROVIDERS = new Set(["claude", "cc", "anthropic"]);

// True when the credential is a Claude subscription (OAuth) token, i.e. the only
// credential Anthropic lets carry the identity line.
export function isClaudeOAuthCredential(token) {
  return typeof token === "string" && token.includes("sk-ant-oat");
}

// Neutralize the identity line inside one system text. Returns "" when the whole
// text is the identity, so the caller can drop the now-empty block.
export function stripClaudeCodeIdentity(text) {
  if (typeof text !== "string") return text;
  if (text.trim() === CLAUDE_CODE_IDENTITY) return "";
  return text
    .replace(/You are Claude Code, Anthropic's official CLI for Claude\.\s*/gi, "")
    .replace(/Claude Code is Anthropic's official CLI for Claude\.\s*/gi, "")
    .replace(/Anthropic's official CLI for Claude/gi, "an AI programming CLI")
    .replace(/You are a Claude agent, built on Anthropic's Claude Agent SDK\.\s*/gi, "")
    .replace(/Anthropic's Claude Agent SDK/gi, "the Agent SDK");
}

// Strip the identity from a Claude-format body in place. Handles the string and
// block-array shapes; empty results are removed so the body never carries an
// empty `system` array.
export function stripClaudeCodeIdentityFromBody(body) {
  if (!body || typeof body !== "object") return body;

  if (typeof body.system === "string") {
    const next = stripClaudeCodeIdentity(body.system);
    if (next.trim()) body.system = next;
    else delete body.system;
    return body;
  }

  if (!Array.isArray(body.system)) return body;

  for (const block of body.system) {
    if (!block || typeof block !== "object" || typeof block.text !== "string") continue;
    block.text = stripClaudeCodeIdentity(block.text);
  }
  body.system = body.system.filter((block) => !(block && typeof block === "object" && block.text === ""));
  if (body.system.length === 0) delete body.system;

  return body;
}
