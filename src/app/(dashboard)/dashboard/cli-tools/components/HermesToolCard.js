"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, ModelSelectModal, ManualConfigModal } from "@/shared/components";
import Image from "next/image";
import BaseUrlSelect from "./BaseUrlSelect";
import ApiKeySelect from "./ApiKeySelect";
import { matchKnownEndpoint } from "./cliEndpointMatch";

const ENDPOINT = "/api/cli-tools/hermes-settings";

export default function HermesToolCard({
  tool,
  isExpanded,
  onToggle,
  hasActiveProviders,
  apiKeys,
  activeProviders,
  cloudEnabled,
  initialStatus,
  tunnelEnabled,
  tunnelPublicUrl,
  tailscaleEnabled,
  tailscaleUrl,
}) {
  const [fetchedStatus, setFetchedStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState(null);
  const [selectedApiKey, setSelectedApiKey] = useState(null);
  const [modelDraft, setModelDraft] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modelAliases, setModelAliases] = useState({});
  const [showManualConfigModal, setShowManualConfigModal] = useState(false);
  const [customBaseUrl, setCustomBaseUrl] = useState("");

  const hermesStatus = fetchedStatus || initialStatus || null;
  const effectiveApiKey = selectedApiKey !== null ? selectedApiKey : (apiKeys?.[0]?.key || "");
  const configuredDefaultModel =
    hermesStatus?.settings?.model?.default ||
    hermesStatus?.settings?.providers?.["888router"]?.default_model ||
    "";
  const selectedModel = modelDraft !== null ? modelDraft : configuredDefaultModel;
  const isChecking = checking || (isExpanded && !hermesStatus);

  const getConfigStatus = () => {
    if (!hermesStatus?.installed) return null;
    const cfg = hermesStatus.settings?.model;
    const p888 = hermesStatus.settings?.providers?.["888router"];
    const configuredUrl = p888?.base_url || cfg?.base_url;
    if (!configuredUrl && !hermesStatus.has9Router) return "not_configured";
    if (
      hermesStatus.has9Router ||
      matchKnownEndpoint(p888?.base_url, { tunnelPublicUrl, tailscaleUrl }) ||
      matchKnownEndpoint(cfg?.base_url, { tunnelPublicUrl, tailscaleUrl })
    ) {
      return "configured";
    }
    return "other";
  };

  const configStatus = getConfigStatus();
  const provider888 = hermesStatus?.settings?.providers?.["888router"];
  const modelCfg = hermesStatus?.settings?.model;
  const currentConfiguredUrl = provider888?.base_url || modelCfg?.base_url || "";
  const hasAffinityHeader = provider888?.session_affinity_header === "x-session-id";
  const hasNamedProvider = modelCfg?.provider === "custom:888router" && Boolean(provider888);

  const checkStatus = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch(ENDPOINT);
      const data = await res.json();
      setFetchedStatus(data);
    } catch (error) {
      setFetchedStatus({ installed: false, error: error.message });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!isExpanded || hermesStatus) return;
    let active = true;
    fetch(ENDPOINT)
      .then((res) => res.json())
      .then((data) => {
        if (active) setFetchedStatus(data);
      })
      .catch((error) => {
        if (active) setFetchedStatus({ installed: false, error: error.message });
      });
    return () => {
      active = false;
    };
  }, [isExpanded, hermesStatus]);

  useEffect(() => {
    if (!isExpanded) return;
    let active = true;
    fetch("/api/models/alias")
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (active && ok) setModelAliases(data.aliases || {});
      })
      .catch((error) => {
        console.log("Error fetching model aliases:", error);
      });
    return () => {
      active = false;
    };
  }, [isExpanded]);

  const normalizeLocalhost = (url) => url.replace("://localhost", "://127.0.0.1");

  const getLocalBaseUrl = () => {
    if (typeof window !== "undefined") {
      return normalizeLocalhost(window.location.origin);
    }
    return "http://127.0.0.1:20128";
  };

  const getEffectiveBaseUrl = () => {
    const url = customBaseUrl || getLocalBaseUrl();
    return url.endsWith("/v1") ? url : `${url}/v1`;
  };

  const handleApply = async () => {
    setApplying(true);
    setMessage(null);
    try {
      const keyToUse = effectiveApiKey?.trim()
        || (apiKeys?.length > 0 ? apiKeys[0].key : null)
        || (!cloudEnabled ? "sk_9router" : null);

      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: getEffectiveBaseUrl(),
          apiKey: keyToUse,
          model: selectedModel,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: "Settings applied successfully!" });
        await checkStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to apply settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setApplying(false);
    }
  };

  const handleReset = async () => {
    setRestoring(true);
    setMessage(null);
    try {
      const res = await fetch(ENDPOINT, { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: "Settings reset successfully!" });
        setModelDraft("");
        await checkStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to reset settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setRestoring(false);
    }
  };

  const handleModelSelect = (model) => {
    setModelDraft(model.value);
    setModalOpen(false);
  };

  const getManualConfigs = () => {
    const keyToUse = (effectiveApiKey && effectiveApiKey.trim())
      ? effectiveApiKey
      : (!cloudEnabled ? "sk_9router" : "<API_KEY_FROM_DASHBOARD>");

    const effectiveUrl = getEffectiveBaseUrl();
    const modelId = selectedModel || "provider/model-id";
    const yamlContent = `model:\n  default: "${modelId}"\n  provider: "custom:888router"\n  base_url: "${effectiveUrl}"\n  api_key: \${OPENAI_API_KEY}\n\nproviders:\n  888router:\n    base_url: "${effectiveUrl}"\n    api_key: \${OPENAI_API_KEY}\n    default_model: "${modelId}"\n    session_affinity_header: "x-session-id"\n    discover_models: true\n`;
    const envContent = `OPENAI_API_KEY=${keyToUse}\n`;

    return [
      { filename: "~/.hermes/config.yaml", content: yamlContent },
      { filename: "~/.hermes/.env", content: envContent },
    ];
  };

  return (
    <Card padding="xs" className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 hover:cursor-pointer sm:items-center" onClick={onToggle}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-8 flex items-center justify-center shrink-0">
            <Image src="/providers/hermes.png" alt={tool.name} width={32} height={32} className="size-8 object-contain rounded-lg" sizes="32px" onError={(e) => { e.target.style.display = "none"; }} />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="font-medium text-sm">{tool.name}</h3>
              {configStatus === "configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-500/10 text-green-600 dark:text-green-400 rounded-full">Connected</span>}
              {configStatus === "not_configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 rounded-full">Not configured</span>}
              {configStatus === "other" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-full">Other</span>}
            </div>
            <p className="text-xs text-text-muted truncate">{tool.description}</p>
          </div>
        </div>
        <span className={`material-symbols-outlined text-text-muted text-[20px] transition-transform ${isExpanded ? "rotate-180" : ""}`}>expand_more</span>
      </div>

      {isExpanded && (
        <div className="mt-4 pt-4 border-t border-border flex flex-col gap-4">
          {isChecking && (
            <div className="flex items-center gap-2 text-text-muted">
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
              <span>Checking Hermes Agent...</span>
            </div>
          )}

          {!isChecking && hermesStatus && !hermesStatus.installed && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                <div className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-yellow-500">warning</span>
                  <div className="flex-1">
                    <p className="font-medium text-yellow-600 dark:text-yellow-400">Hermes Agent not detected locally</p>
                    <p className="text-sm text-text-muted">Install: curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash</p>
                  </div>
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 pl-0 sm:pl-9">
                  <Button variant="secondary" size="sm" onClick={() => setShowManualConfigModal(true)} className="w-full sm:w-auto !bg-yellow-500/20 !border-yellow-500/40 !text-yellow-700 dark:!text-yellow-300 hover:!bg-yellow-500/30">
                    <span className="material-symbols-outlined text-[18px] mr-1">content_copy</span>
                    Manual Config
                  </Button>
                </div>
              </div>
              <div className="rounded-lg border border-border bg-bg-alt/50 px-3 py-2 text-xs text-text-muted space-y-1">
                <p className="font-medium text-text-main m-0">
                  Manual setup uses <code className="font-mono text-[11px]">custom:888router</code> + <code className="font-mono text-[11px]">providers.888router</code>
                </p>
                <p className="m-0 leading-relaxed">
                  Includes <code className="font-mono text-[11px]">session_affinity_header: &quot;x-session-id&quot;</code> and <code className="font-mono text-[11px]">discover_models: true</code> in <code className="font-mono text-[11px]">~/.hermes/config.yaml</code>.
                </p>
              </div>
            </div>
          )}

          {!isChecking && hermesStatus?.installed && (
            <>
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Select Endpoint</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <BaseUrlSelect
                    value={customBaseUrl || getEffectiveBaseUrl()}
                    onChange={setCustomBaseUrl}
                    requiresExternalUrl={tool.requiresExternalUrl}
                    tunnelEnabled={tunnelEnabled}
                    tunnelPublicUrl={tunnelPublicUrl}
                    tailscaleEnabled={tailscaleEnabled}
                    tailscaleUrl={tailscaleUrl}
                  />
                </div>

                {currentConfiguredUrl && (
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                    <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Current</span>
                    <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <span className="min-w-0 truncate rounded bg-surface/40 px-2 py-2 text-xs text-text-muted sm:py-1.5">
                        {currentConfiguredUrl}
                      </span>
                      {hasNamedProvider && (
                        <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-primary/10 text-primary">
                          custom:888router
                        </span>
                      )}
                      {hasAffinityHeader && (
                        <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-green-500/10 text-green-600 dark:text-green-400">
                          x-session-id
                        </span>
                      )}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">API Key</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <ApiKeySelect value={effectiveApiKey} onChange={setSelectedApiKey} apiKeys={apiKeys} cloudEnabled={cloudEnabled} />
                </div>

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Default Model</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <div className="relative w-full min-w-0">
                    <input type="text" value={selectedModel} onChange={(e) => setModelDraft(e.target.value)} placeholder="provider/model-id" className="w-full min-w-0 pl-2 pr-7 py-2 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5" />
                    {selectedModel && <button type="button" onClick={() => setModelDraft("")} className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-text-muted hover:text-red-500 rounded transition-colors" title="Clear"><span className="material-symbols-outlined text-[14px]">close</span></button>}
                  </div>
                  <button type="button" onClick={() => setModalOpen(true)} disabled={!hasActiveProviders} className={`w-full sm:w-auto rounded border px-2 py-2 text-xs transition-colors sm:py-1.5 whitespace-nowrap sm:shrink-0 ${hasActiveProviders ? "bg-surface border-border text-text-main hover:border-primary cursor-pointer" : "opacity-50 cursor-not-allowed border-border"}`}>Select</button>
                </div>
              </div>

              <div className="rounded-lg border border-border bg-bg-alt/50 px-3 py-2 text-xs text-text-muted space-y-1">
                <p className="font-medium text-text-main m-0">
                  Named Provider & Session Affinity (<code className="font-mono text-[11px]">custom:888router</code>)
                </p>
                <p className="m-0 leading-relaxed">
                  Apply writes <code className="font-mono text-[11px]">model.provider: &quot;custom:888router&quot;</code> and <code className="font-mono text-[11px]">providers.888router</code> in <code className="font-mono text-[11px]">~/.hermes/config.yaml</code> with <code className="font-mono text-[11px]">session_affinity_header: &quot;x-session-id&quot;</code> so Hermes sessions stay pinned to one account and preserve Prompt Cache.
                </p>
                {configStatus === "configured" && (!hasNamedProvider || !hasAffinityHeader) && (
                  <p className="m-0 text-amber-600 dark:text-amber-400">
                    Legacy config detected — click Apply to add <code className="font-mono text-[11px]">providers.888router</code> and <code className="font-mono text-[11px]">session_affinity_header</code>.
                  </p>
                )}
              </div>

              {message && (
                <div className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${message.type === "success" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}>
                  <span className="material-symbols-outlined text-[14px]">{message.type === "success" ? "check_circle" : "error"}</span>
                  <span>{message.text}</span>
                </div>
              )}

              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <Button variant="primary" size="sm" onClick={handleApply} disabled={!selectedModel} loading={applying} className="w-full sm:w-auto">
                  <span className="material-symbols-outlined text-[14px] mr-1">save</span>Apply
                </Button>
                <Button variant="outline" size="sm" onClick={handleReset} disabled={!(hermesStatus?.has9Router || configStatus === "configured")} loading={restoring} className="w-full sm:w-auto">
                  <span className="material-symbols-outlined text-[14px] mr-1">restore</span>Reset
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowManualConfigModal(true)} className="w-full sm:w-auto">
                  <span className="material-symbols-outlined text-[14px] mr-1">content_copy</span>Manual Config
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      <ModelSelectModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSelect={handleModelSelect}
        selectedModel={selectedModel}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        title="Select Model for Hermes Agent"
      />

      <ManualConfigModal
        isOpen={showManualConfigModal}
        onClose={() => setShowManualConfigModal(false)}
        title="Hermes Agent - Manual Configuration"
        configs={getManualConfigs()}
      />
    </Card>
  );
}
