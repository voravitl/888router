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
    <Card className="hyperion-card border border-amber-500/35 bg-gradient-to-r from-amber-500/10 via-rose-500/5 to-transparent">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/15 text-amber-400">
            <span className="material-symbols-outlined text-[18px]">lock</span>
          </div>
          <div>
            <p className="font-semibold text-sm text-text-main flex items-center gap-2">
              <span>Circuit-Broken / Locked Hops</span>
              <span className="rounded-full bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 font-mono text-[10px] text-amber-400">
                {locks.length} paused
              </span>
            </p>
            <p className="text-xs text-text-muted">Combos skip these hops until cooldown expires. Unlock manually after quota reset or key fix.</p>
          </div>
        </div>
        <Button size="sm" variant="secondary" disabled={busy === "all"} onClick={() => unlock({ all: true }, "all")}>
          Unlock all
        </Button>
      </div>
      <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 max-h-64 overflow-auto">
        {locks.map((l) => (
          <li
            key={l.model}
            className="flex items-center justify-between gap-2 rounded-xl border border-amber-500/20 bg-black/20 px-3 py-2 text-xs"
          >
            <div className="min-w-0">
              <div className="font-mono font-semibold text-text-main truncate">{l.model}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-muted">
                <span className="rounded bg-rose-500/15 border border-rose-500/25 px-1.5 py-0.5 text-[10px] text-rose-300">
                  {REASON_LABEL[l.reason] || l.reason}
                </span>
                <span className="font-mono text-amber-300">{formatLeft(l.until)} left</span>
              </div>
            </div>
            <Button size="sm" variant="ghost" disabled={busy === l.model} onClick={() => unlock({ model: l.model }, l.model)}>
              Unlock
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
