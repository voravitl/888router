"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import Card from "./Card";
import Select from "./Select";
import Badge from "./Badge";
import Button from "./Button";

const NONE_PROXY_POOL_VALUE = "__none__";

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
      // Revert state on error (MEDIUM #3)
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
  const isSpecificPoolSelected = proxyPoolId !== NONE_PROXY_POOL_VALUE;
  const selectedPool = proxyPools.find((p) => p.id === proxyPoolId);

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-green-500/10 text-green-500">
          <span className="material-symbols-outlined text-[20px]">lock_open</span>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">No authentication required</p>
          <p className="text-xs text-text-muted">This provider is ready to use. Optionally route requests through a proxy pool to bypass IP-based limits.</p>
        </div>
        {savedFlash && <Badge variant="success" size="sm">Saved</Badge>}
      </div>

      <div className="flex flex-col gap-4">
        <div>
          <Select
            label="Proxy Pool"
            value={proxyPoolId}
            onChange={(e) => handleSettingChange({ proxyPoolId: e.target.value })}
            disabled={saving || testing}
            options={[
              { value: NONE_PROXY_POOL_VALUE, label: "None (direct)" },
              ...proxyPools.map((pool) => ({ value: pool.id, label: pool.name })),
            ]}
          />
          {activePoolsCount > 0 && !isSpecificPoolSelected && (
            <p className="mt-1.5 text-xs text-text-muted">
              Pool selector is ignored when rotation is active — all active pools are used.
            </p>
          )}
        </div>

        <div>
          <Select
            label="Rotation Strategy"
            value={rotationStrategy}
            onChange={(e) => handleSettingChange({ rotationStrategy: e.target.value })}
            disabled={saving || testing}
            options={[
              { value: "round-robin", label: "Round-robin" },
              { value: "random", label: "Random" },
              { value: "fill-first", label: "Fill-first" },
            ]}
          />
        </div>

        {/* Info Box (Neutral styling, matches Threads screenshot) */}
        <div className="rounded-lg border border-black/10 bg-black/[0.02] px-4 py-3 text-xs text-text-muted dark:border-white/10 dark:bg-white/[0.03]">
          {activePoolsCount > 0 ? (
            isSpecificPoolSelected ? (
              <span>
                Using pool &quot;<strong className="text-text-main">{selectedPool?.name || proxyPoolId}</strong>&quot; ({activePoolsCount} active pools available).
              </span>
            ) : (
              <span>
                Rotating through all <strong className="text-text-main">{activePoolsCount} active pools</strong> in order. State is in-memory (resets on restart).
              </span>
            )
          ) : (
            <span>No active proxy pools configured. Direct connection will be used.</span>
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <Button
            size="sm"
            variant="secondary"
            icon="sync"
            onClick={handleTestConnection}
            disabled={saving || testing}
          >
            {testing ? "Testing..." : "Test Connection"}
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

        {proxyPools.length === 0 && (
          <p className="text-xs text-text-muted">
            No active proxy pools available. Create one in{" "}
            <a href="/dashboard/proxy-pools" className="text-primary underline font-medium">
              Proxy Pools page
            </a>{" "}
            first.
          </p>
        )}
      </div>
    </Card>
  );
}

NoAuthProxyCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
