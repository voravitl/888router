import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

// Claude Code reads context window from a hardcoded binary registry — it does
// NOT honour `context_window` from /v1/models. The only way to activate its
// 1M-context entry for a custom-provider model is to append "[1m]" to the id.
// (Server strips the suffix before forwarding upstream — see chat handler.)
//
// Return the model id with "[1m]" appended IFF its resolved context window is
// ≥ 1M, so copying from the Web Dashboard "just works" with Claude Code.
const ONE_MILLION = 1_000_000;

export function getClaudeCodeModelId(providerAlias, modelId) {
  const id = String(modelId || "");
  const cw = getCapabilitiesForModel(providerAlias, id)?.contextWindow;
  return cw && cw >= ONE_MILLION ? `${id}[1m]` : id;
}

// Full id ("alias/model") with [1m] when the model is 1M-capable.
export function getClaudeCodeFullModelId(providerAlias, modelId) {
  const alias = String(providerAlias || "");
  return `${alias}/${getClaudeCodeModelId(alias, modelId)}`;
}
