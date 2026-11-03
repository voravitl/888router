/**
 * Strip secrets that live inside providerSpecificData before a connection is
 * returned to the browser. The Token Plan quota console cookie
 * (`consoleCookie`) is one — it must stay server-side. Sets a boolean
 * `hasConsoleCookie` so the UI can show "cookie saved" without seeing it.
 */
const SENSITIVE_PSD_FIELDS = ["consoleCookie"];

export function stripSensitiveProviderSpecificData(connection) {
  if (!connection || typeof connection !== "object") return connection;
  const psd = connection.providerSpecificData;
  if (!psd || typeof psd !== "object") return connection;

  const clean = {};
  for (const [key, value] of Object.entries(psd)) {
    if (!SENSITIVE_PSD_FIELDS.includes(key)) clean[key] = value;
  }

  return {
    ...connection,
    // Same notion of "stored" as the usage handler: whitespace is not a cookie.
    hasConsoleCookie: String(psd.consoleCookie ?? "").trim() !== "",
    providerSpecificData: clean,
  };
}
