import { getAllModelDynamicCapabilities } from "@/lib/db/repos/syncedModelsRepo.js";
import { registerDynamicCapabilitiesScoped } from "open-sse/providers/capabilities.js";

const REFRESH_MS = 30000;
const RETRY_MS = 5000;
const READ_TIMEOUT_MS = 1000;
let refreshAfter = 0;
let inFlight = null;

// Hydrate before routing, including the first chat after process startup. This
// reads persisted metadata only; no upstream discovery or database writes.
export async function ensureModelContextLoaded(log) {
  if (inFlight) return inFlight;
  if (Date.now() < refreshAfter) return;
  inFlight = (async () => {
    let timer;
    try {
      const rows = await Promise.race([
        getAllModelDynamicCapabilities(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Model context read timeout")), READ_TIMEOUT_MS);
        }),
      ]);
      for (const [key, caps] of rows) {
        const colon = typeof key === "string" ? key.indexOf(":") : -1;
        if (colon <= 0 || colon === key.length - 1) continue;
        registerDynamicCapabilitiesScoped(key.slice(0, colon), key.slice(colon + 1), caps);
      }
      refreshAfter = Date.now() + REFRESH_MS;
    } catch {
      refreshAfter = Date.now() + RETRY_MS;
      log?.warn?.("MODEL_CONTEXT", "Synced model metadata unavailable; using current declared limits and retrying shortly.");
    } finally {
      clearTimeout(timer);
    }
  })();
  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
}
