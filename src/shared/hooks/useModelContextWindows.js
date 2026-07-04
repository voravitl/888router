"use client";

import { useState, useEffect } from "react";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

// Module-level cache so the whole app fetches /v1/models once, not per-row.
// Shape: { "alias/model": contextWindow, ... } for the ~90% of models the
// server already knows a context window for.
let cache = null;
let inflight = null;

async function loadContextWindows() {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch("/v1/models", { credentials: "include" });
      if (!res.ok) return null;
      const data = await res.json();
      const map = {};
      for (const m of data.data || []) {
        const id = m?.id;
        if (!id) continue;
        const cw = m.context_window || m.contextWindow;
        if (cw) map[id] = cw;
      }
      cache = map;
      return map;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

const ONE_MILLION = 1_000_000;

/**
 * Returns a lookup: (fullModel: "alias/model") => contextWindow (number|undefined).
 * `ready` is false until the first fetch settles; callers may copy with a
 * catalog fallback in the meantime.
 */
export function useModelContextWindows() {
  const [map, setMap] = useState(cache);
  const [ready, setReady] = useState(!!cache);

  useEffect(() => {
    let alive = true;
    if (cache) { setMap(cache); setReady(true); return; }
    loadContextWindows().then((m) => {
      if (alive && m) { setMap(m); setReady(true); }
    });
    return () => { alive = false; };
  }, []);

  return { contextByFullModel: map || {}, ready };
}

/**
 * Resolve a full model id to its context window — prefer the cached live
 * /v1/models entry, fall back to the static capability catalog, then undefined.
 */
export function resolveContextWindow(contextByFullModel, fullModel) {
  if (typeof fullModel !== "string" || !fullModel.includes("/")) return undefined;
  if (contextByFullModel[fullModel]) return contextByFullModel[fullModel];
  const slash = fullModel.indexOf("/");
  const alias = fullModel.slice(0, slash);
  const model = fullModel.slice(slash + 1);
  return getCapabilitiesForModel(alias, model)?.contextWindow;
}

export function isOneMillionContext(cw) {
  return typeof cw === "number" && cw >= ONE_MILLION;
}
