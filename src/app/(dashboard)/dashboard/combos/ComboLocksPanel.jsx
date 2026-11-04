"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button } from "@/shared/components";

const REASON_LABEL = {
  "long-quota": "quota",
  "rate-limit": "rate limit",
  permanent: "model error",
  auth: "401 credential",
  "auth-park": "pool parked",
  "head-timeout": "slow stream",
  transient: "transient",
};

function formatLeft(until) {
  const s = Math.max(0, Math.round((until - Date.now()) / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

// Lists models the combo router is skipping (quota / 401 / slow-stream locks)
// and lets the operator unlock them, e.g. after topping up or fixing a key.
export default function ComboLocksPanel() {
  const [locks, setLocks] = useState([]);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/combos/locks");
      if (res.ok) setLocks((await res.json()).locks || []);
    } catch {
      // keep the last list; the next poll retries
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const unlock = async (payload, key) => {
    setBusy(key);
    try {
      await fetch("/api/combos/locks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (locks.length === 0) return null;

  return (
    <Card>
      <div className="flex items-center justify-between gap-2 mb-3">
        <div>
          <p className="font-medium text-text-main">Locked models ({locks.length})</p>
          <p className="text-xs text-text-muted">Combos skip these until the lock expires. Unlock after topping up quota or fixing a key.</p>
        </div>
        <Button size="sm" variant="secondary" disabled={busy === "all"} onClick={() => unlock({ all: true }, "all")}>
          Unlock all
        </Button>
      </div>
      <ul className="flex flex-col gap-1 max-h-64 overflow-auto">
        {locks.map((l) => (
          <li key={l.model} className="flex items-center justify-between gap-2 text-sm">
            <span className="truncate">
              <span className="font-mono">{l.model}</span>
              <span className="text-text-muted"> · {REASON_LABEL[l.reason] || l.reason} · {formatLeft(l.until)} left</span>
            </span>
            <Button size="sm" variant="ghost" disabled={busy === l.model} onClick={() => unlock({ model: l.model }, l.model)}>
              Unlock
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
