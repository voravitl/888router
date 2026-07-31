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
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [providerId]);

  const handleChange = async (newValue) => {
    setProxyPoolId(newValue);
    setTestResult(null);
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const override = { ...(current[providerId] || {}) };
      if (newValue === NONE_PROXY_POOL_VALUE) delete override.proxyPoolId;
      else override.proxyPoolId = newValue;
      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      console.log("Save proxyPoolId error:", e);
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
      const data = await res.json();
      if (res.ok && data.valid) {
        setTestResult({ valid: true });
      } else {
        setTestResult({ valid: false, error: data.error || "Connection probe failed" });
      }
    } catch (err) {
      setTestResult({ valid: false, error: err.message || "Network error" });
    } finally {
      setTesting(false);
    }
  };

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
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex-1">
          <Select
            label="Proxy Pool"
            value={proxyPoolId}
            onChange={(e) => handleChange(e.target.value)}
            disabled={saving || testing}
            options={[
              { value: NONE_PROXY_POOL_VALUE, label: "None (direct)" },
              ...proxyPools.map((pool) => ({ value: pool.id, label: pool.name })),
            ]}
          />
        </div>
        <Button
          size="sm"
          variant="secondary"
          icon="sync"
          onClick={handleTestConnection}
          disabled={saving || testing}
          className="shrink-0"
        >
          {testing ? "Testing..." : "Test Connection"}
        </Button>
      </div>

      {testResult && (
        <div className="mt-3 flex items-center gap-2">
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

      {proxyPools.length === 0 && (
        <p className="mt-2 text-xs text-text-muted">
          No active proxy pools available. Create one in{" "}
          <a href="/dashboard/proxy-pools" className="text-primary underline font-medium">
            Proxy Pools page
          </a>{" "}
          first.
        </p>
      )}
    </Card>
  );
}

NoAuthProxyCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
