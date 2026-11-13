"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "antd";
import { LockOutlined, UnlockOutlined } from "@ant-design/icons";
import { Card } from "@/shared/components";

export const LOCK_REASON_LABEL = {
  "long-quota": "quota",
  "rate-limit": "rate limit",
  permanent: "model error",
  auth: "401 credential",
  "auth-park": "pool parked",
  "head-timeout": "slow stream",
  transient: "transient",
};

export function formatLockTimeLeft(until) {
  const s = Math.max(0, Math.round((until - Date.now()) / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

// Lists models the combo router is skipping (quota / 401 / slow-stream locks)
// and lets the operator unlock them, e.g. after topping up or fixing a key.
export default function ComboLocksPanel({ locks: controlledLocks = null, onRefresh = null }) {
  const [internalLocks, setInternalLocks] = useState([]);
  const [busy, setBusy] = useState(null);

  const isControlled = Array.isArray(controlledLocks);
  const locks = isControlled ? controlledLocks : internalLocks;

  const load = useCallback(async () => {
    if (onRefresh) {
      await onRefresh();
      return;
    }
    try {
      const res = await fetch("/api/combos/locks");
      if (res.ok) setInternalLocks((await res.json()).locks || []);
    } catch {
      // keep the last list; the next poll retries
    }
  }, [onRefresh]);

  useEffect(() => {
    if (isControlled) return;
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [isControlled, load]);

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
    <Card padding="sm" className="border border-amber-500/30 bg-surface">
      <div className="flex items-start justify-between gap-2 pb-2.5 border-b border-border-subtle mb-2.5">
        <div className="flex items-start gap-2.5 min-w-0">
          <div className="flex size-8 items-center justify-center rounded-lg border border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-400 shrink-0">
            <LockOutlined />
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-xs text-text-main flex items-center gap-2">
              <span>Circuit-Broken Hops</span>
              <span className="rounded border border-amber-500/35 bg-amber-500/10 px-1.5 py-0.2 font-mono text-[10px] text-amber-700 dark:text-amber-300 tabular-nums">
                {locks.length} paused
              </span>
            </div>
            <p className="text-[11px] text-text-muted mt-0.5 leading-snug m-0">
              Skipped until cooldown expires. Unlock manually after quota reset.
            </p>
          </div>
        </div>
        <Button
          size="small"
          loading={busy === "all"}
          onClick={() => unlock({ all: true }, "all")}
        >
          Unlock All
        </Button>
      </div>

      <ul className="grid grid-cols-1 gap-2 max-h-60 overflow-y-auto m-0 p-0 list-none">
        {locks.map((l) => (
          <li
            key={l.model}
            className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle bg-bg-alt px-2.5 py-2 text-xs"
          >
            <div className="min-w-0 flex-1">
              <div className="font-mono font-semibold text-[11px] text-text-main truncate">
                {l.model}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-[10px]">
                <span className="rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.2 font-medium text-red-600 dark:text-red-400">
                  {LOCK_REASON_LABEL[l.reason] || l.reason}
                </span>
                <span className="font-mono text-amber-700 dark:text-amber-400 tabular-nums">
                  {formatLockTimeLeft(l.until)} left
                </span>
              </div>
            </div>
            <Button
              size="small"
              icon={<UnlockOutlined />}
              loading={busy === l.model}
              onClick={() => unlock({ model: l.model }, l.model)}
            >
              Unlock
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
