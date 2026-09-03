"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import Card from "./Card";
import Select from "./Select";
import Badge from "./Badge";
import Button from "./Button";

const NONE_PROXY_POOL_VALUE = "__none__";
const DIRECT_PROXY_VALUE = "__direct__";

export default function NoAuthProxyCard({ providerId }) {
  const [proxyPools, setProxyPools] = useState([]);
  const [proxyPoolId, setProxyPoolId] = useState(NONE_PROXY_POOL_VALUE);
  const [rotationStrategy, setRotationStrategy] = useState("round-robin");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }).then((r) => r.ok ? r.json() : { proxyPools: [] }),
      fetch("/api/settings", { cache: "no-store" }).then((r) => r.ok ? r.json() : {}),
    ]).then(([poolData, settingsData]) => {
      if (cancelled) return;
      setProxyPools(poolData.proxyPools || []);
      const override = (settingsData.providerStrategies || {})[providerId] || {};
      setProxyPoolId(override.proxyPoolId || NONE_PROXY_POOL_VALUE);
      setRotationStrategy(override.rotationStrategy || "round-robin");
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [providerId]);

  const handleSettingChange = async (updates) => {
    const prevProxyPoolId = proxyPoolId;
    const prevRotationStrategy = rotationStrategy;

    const nextProxyPoolId = "proxyPoolId" in updates ? updates.proxyPoolId : proxyPoolId;
    const nextRotationStrategy = "rotationStrategy" in updates ? updates.rotationStrategy : rotationStrategy;

    if ("proxyPoolId" in updates) setProxyPoolId(nextProxyPoolId);
    if ("rotationStrategy" in updates) setRotationStrategy(nextRotationStrategy);

    setTestResult(null);
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json().catch(() => ({})) : {};
      const current = data.providerStrategies || {};
      const override = { ...(current[providerId] || {}) };

      if (nextProxyPoolId === NONE_PROXY_POOL_VALUE) delete override.proxyPoolId;
      else override.proxyPoolId = nextProxyPoolId;

      if (nextRotationStrategy !== "round-robin") override.rotationStrategy = nextRotationStrategy;
      else delete override.rotationStrategy;

      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;

      const patchRes = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });

      if (!patchRes.ok) {
        throw new Error("Failed to save settings");
      }

      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      console.error("Save settings error:", e);
      setProxyPoolId(prevProxyPoolId);
      setRotationStrategy(prevRotationStrategy);
      setTestResult({ valid: false, error: "Failed to save settings" });
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: providerId,
          proxyPoolId: proxyPoolId !== NONE_PROXY_POOL_VALUE ? proxyPoolId : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.valid) {
        setTestResult({ valid: true });
      } else {
        setTestResult({ valid: false, error: data.error || `HTTP ${res.status} error` });
      }
    } catch (err) {
      setTestResult({ valid: false, error: err.message || "Network error" });
    } finally {
      setTesting(false);
    }
  };

  const activePoolsCount = proxyPools.length;
  const isDirectSelected = proxyPoolId === DIRECT_PROXY_VALUE;
  const isSpecificPoolSelected = proxyPoolId !== NONE_PROXY_POOL_VALUE && !isDirectSelected;
  const selectedPool = proxyPools.find((p) => p.id === proxyPoolId);

  return (
    <Card>
      {/* Header */}
      <div className="flex items-start gap-3 mb-5">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-green-500/10 text-green-500 shrink-0">
          <span className="material-symbols-outlined text-[22px]">verified_user</span>
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-text-main">No Authentication Required</h3>
            <Badge variant="success" size="sm" dot>Free & Ready</Badge>
          </div>
          <p className="text-xs text-text-muted mt-0.5">
            This provider offers free unlimited access. Route requests through Proxy Pools to automatically bypass IP rate limits.
          </p>
        </div>
        {savedFlash && <Badge variant="success" size="sm">Saved</Badge>}
      </div>

      <div className="flex flex-col gap-4">
        {/* Proxy Pool Selector */}
        <div>
          <Select
            label="Proxy Routing Strategy"
            value={proxyPoolId}
            onChange={(e) => handleSettingChange({ proxyPoolId: e.target.value })}
            disabled={saving || testing}
            options={[
              {
                value: NONE_PROXY_POOL_VALUE,
                label: activePoolsCount > 0
                  ? `🔄 Auto-Rotate All Active Pools (${activePoolsCount} pools)`
                  : "⚡ Direct Connection (No Proxy)",
              },
              ...(activePoolsCount > 0
                ? [{ value: DIRECT_PROXY_VALUE, label: "⚡ Direct Connection (Local IP, No Proxy)" }]
                : []),
              ...proxyPools.map((pool) => ({
                value: pool.id,
                label: `📌 Specific Pool: ${pool.name}`,
              })),
            ]}
          />
        </div>

        {/* Rotation Strategy Selector (Only visible when auto-rotating) */}
        {!isSpecificPoolSelected && !isDirectSelected && activePoolsCount > 0 && (
          <div className="pl-3 border-l-2 border-primary/30">
            <Select
              label="Rotation Algorithm"
              value={rotationStrategy}
              onChange={(e) => handleSettingChange({ rotationStrategy: e.target.value })}
              disabled={saving || testing}
              options={[
                { value: "round-robin", label: "Round-robin (Equal sequential load)" },
                { value: "random", label: "Random (Unpredictable IP distribution)" },
                { value: "fill-first", label: "Fill-first (Use primary node until capped)" },
              ]}
            />
          </div>
        )}

        {/* Live Proxy Status Banner */}
        <div className="rounded-xl border border-black/10 bg-black/[0.02] p-3.5 text-xs text-text-muted dark:border-white/10 dark:bg-white/[0.03]">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px] text-primary">alt_route</span>
            <span className="font-medium text-text-main">Current Routing Status:</span>
          </div>

          <div className="mt-1.5 pl-6 text-text-muted">
            {isDirectSelected ? (
              <span>All requests are routed <strong className="text-text-main">directly using local server IP</strong> (bypassing all proxy pools).</span>
            ) : activePoolsCount > 0 ? (
              isSpecificPoolSelected ? (
                <span>
                  All requests are routed exclusively through pool &quot;<strong className="text-text-main">{selectedPool?.name || proxyPoolId}</strong>&quot;.
                </span>
              ) : (
                <span>
                  Automatically rotating requests across all <strong className="text-text-main">{activePoolsCount} active proxy pools</strong> using <strong className="text-text-main">{rotationStrategy}</strong> algorithm.
                </span>
              )
            ) : (
              <span>No active proxy pools configured. Requests will use local server IP directly.</span>
            )}
          </div>
        </div>

        {/* Action & Validation Bar */}
        <div className="flex items-center justify-between gap-3 pt-1">
          <Button
            size="sm"
            variant="secondary"
            icon="sync"
            onClick={handleTestConnection}
            disabled={saving || testing}
          >
            {testing ? "Testing Connection..." : "Test Connection"}
          </Button>

          {testResult && (
            <div>
              {testResult.valid ? (
                <Badge variant="success" size="sm" dot>
                  Connected & Valid
                </Badge>
              ) : (
                <Badge variant="danger" size="sm" dot>
                  Connection Failed: {testResult.error}
                </Badge>
              )}
            </div>
          )}
        </div>

        {activePoolsCount === 0 && (
          <p className="text-xs text-text-muted">
            💡 Tip: Add proxy nodes in{" "}
            <a href="/dashboard/proxy-pools" className="text-primary underline font-medium">
              Proxy Pools page
            </a>{" "}
            to enable IP rate limit bypassing.
          </p>
        )}
      </div>
    </Card>
  );
}

NoAuthProxyCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
