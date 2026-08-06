import { getSettings } from "@/lib/db/repos/settingsRepo.js";

let envOverride = null;

if (typeof process !== "undefined" && process.env.ENABLE_REQUEST_LOGS !== undefined) {
  envOverride = process.env.ENABLE_REQUEST_LOGS === "true";
  console.log(
    `[requestLogger] ENABLE_REQUEST_LOGS=${process.env.ENABLE_REQUEST_LOGS} — overriding database setting to ${envOverride}`
  );
}

/**
 * Get the effective request logging state, combining the database setting
 * with the ENABLE_REQUEST_LOGS environment variable override.
 * The env var takes precedence when set.
 */
export async function isRequestLoggingEnabled() {
  if (envOverride !== null) {
    return envOverride;
  }
  const settings = await getSettings();
  return settings.enableObservability === true;
}
