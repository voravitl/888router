"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Button from "./Button";
import Badge from "./Badge";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

export default function ProviderMcpSetupModal({ isOpen, onClose, provider }) {
  const { copy } = useCopyToClipboard();
  const [copiedKey, setCopiedKey] = useState(null);

  if (!provider) return null;

  const providerId = provider.id;
  const providerName = provider.name || providerId;
  const kind = provider.kind || "webSearch";

  const mcpOrigin = typeof window !== "undefined" && window.location.origin
    ? window.location.origin
    : "http://localhost:20128";

  const mcpServerName = `888router-${providerId}`;
  const sseUrl = `${mcpOrigin}/api/mcp/${providerId}/sse`;

  const mcpConfig = {
    mcpServers: {
      [mcpServerName]: {
        url: sseUrl,
        headers: { Authorization: "Bearer local" }
      }
    }
  };

  const aiPrompt = `Please set up the 888router MCP server for ${providerName} (${kind}) in my local environment automatically.

IMPORTANT MERGE INSTRUCTION:
Do NOT replace or overwrite existing configuration files completely.
Read the existing ~/.mcp.json file first, parse the JSON, merge these keys, and write back.

Merge MCP server configuration into ~/.mcp.json:
${JSON.stringify(mcpConfig, null, 2)}

Please write/merge this configuration file now and verify that ${mcpServerName} MCP server is active.`;

  const handleCopy = (text, key) => {
    copy(text, key);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`MCP Setup — ${providerName}`} size="xl">
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-2">
          <Badge variant="primary" size="sm">Provider MCP</Badge>
          <span className="text-xs text-text-muted">Routes requests through 888router & active Proxy Pools</span>
        </div>

        {/* AI Setup Prompt */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-text-main">
              🤖 AI Setup Prompt (Copy & Paste to your AI Assistant)
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleCopy(aiPrompt, "prompt")}
            >
              <span className="material-symbols-outlined text-[14px] mr-1">
                {copiedKey === "prompt" ? "check" : "content_copy"}
              </span>
              {copiedKey === "prompt" ? "Copied!" : "Copy Prompt"}
            </Button>
          </div>
          <pre className="px-3.5 py-3 bg-black/5 dark:bg-white/5 rounded-xl font-mono text-xs overflow-x-auto whitespace-pre-wrap break-all max-h-48 overflow-y-auto border border-border">
            {aiPrompt}
          </pre>
        </div>

        {/* JSON Snippet */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-text-main">~/.mcp.json (Manual Config)</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleCopy(JSON.stringify(mcpConfig, null, 2), "json")}
            >
              <span className="material-symbols-outlined text-[14px] mr-1">
                {copiedKey === "json" ? "check" : "content_copy"}
              </span>
              {copiedKey === "json" ? "Copied!" : "Copy JSON"}
            </Button>
          </div>
          <pre className="px-3.5 py-3 bg-black/5 dark:bg-white/5 rounded-xl font-mono text-xs overflow-x-auto whitespace-pre-wrap break-all max-h-40 overflow-y-auto border border-border text-primary">
            {JSON.stringify(mcpConfig, null, 2)}
          </pre>
        </div>
      </div>
    </Modal>
  );
}

ProviderMcpSetupModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  provider: PropTypes.object,
};
