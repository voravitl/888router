"use client";

import { useState, useEffect, useCallback } from "react";
import { getCapabilitiesForModel, resolveKnownContextWindow } from "open-sse/providers/capabilities.js";
import { buildCapsIndexes, resolveModelCaps } from "@/shared/utils/modelCapsMerge";

// Fetch model capabilities once and expose a lookup by fullModel ("provider/model") or bare model id.
// `byFull` is scoped: one provider's dynamic caps can never leak into another's row.
export function useModelCaps() {
  const [byFull, setByFull] = useState({});
  const [byId, setById] = useState({});

  const fetchCaps = useCallback(async () => {
    try {
      const res = await fetch("/api/models");
      if (!res.ok) return;
      const data = await res.json();
      const indexes = buildCapsIndexes(data);
      setByFull(indexes.byFull);
      setById(indexes.byId);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    // Initial catalog fetch is a one-shot external read on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchCaps();

    const handleInvalidate = () => {
      fetchCaps();
    };

    window.addEventListener("customModelChanged", handleInvalidate);
    return () => {
      window.removeEventListener("customModelChanged", handleInvalidate);
    };
  }, [fetchCaps]);

  // getCaps(key) stays backward compatible. Pass a model row as the second
  // argument so explicit caps win, and an optional alias key as the third so a
  // dynamic cap stored under `ocg/model` is found from `opencode-go/model`.
  const getCaps = useCallback(
    (key, modelOverride = null, aliasKey = null) => resolveModelCaps({
      key,
      aliasKey,
      modelOverride,
      byFull,
      byId,
      fallbackFor: (provider, bare) => {
        const c = getCapabilitiesForModel(provider, bare);
        // Use resolveKnownContextWindow so genuine unknown models return
        // undefined instead of a 200000 floor.
        return {
          vision: c.vision,
          search: c.search,
          reasoning: c.reasoning,
          contextWindow: resolveKnownContextWindow(provider, bare),
          maxOutput: c.maxOutput,
        };
      },
    }),
    [byFull, byId]
  );

  return { getCaps };
}
