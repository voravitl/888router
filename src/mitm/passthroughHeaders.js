"use strict";

/**
 * Remove internal anti-loop header(s) from passthrough request headers so
 * 888router never forwards private proxy markers upstream to external APIs.
 */
function stripInternalLoopHeaders(headers, headerName = "x-request-source") {
  const next = { ...(headers || {}) };
  const targetLower = String(headerName || "").toLowerCase();
  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === targetLower) {
      delete next[key];
    }
  }
  return next;
}

module.exports = {
  stripInternalLoopHeaders,
};
