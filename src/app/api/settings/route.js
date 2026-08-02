import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { resolveUniversalToolsMode, universalToolsLockedByEnv } from "open-sse/translator/concerns/universalToolPrompt.js";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import { runQuotaAutoPingTick } from "@/shared/services/quotaAutoPing";
import bcrypt from "bcryptjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

// Secrets must never be mass-assigned from request body (CWE-915)
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted"];

export async function GET() {
  try {
    const settings = await getSettings();
    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";
    
    return NextResponse.json({ 
      ...safeSettings, 
      enableRequestLogs,
      enableTranslator,
      // Effective universal tools mode: resolveUniversalToolsMode is the single
      // source of truth (env set = authoritative; else DB value, default "auto").
      universalToolsMode: resolveUniversalToolsMode(safeSettings.universalToolsMode),
      // True when env UNIVERSAL_TOOLS_MODE is set — UI toggle should be read-only.
      universalToolsLockedByEnv: universalToolsLockedByEnv(),
      hasPassword: !!password
    }, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();

    // Strip protected secrets before any internal handling sets them
    for (const key of PROTECTED_SETTING_KEYS) delete body[key];

    // If updating password, hash it
    if (body.newPassword) {
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First time setting password, no current password needed
        // Allow empty currentPassword or default "123456"
        if (body.currentPassword && body.currentPassword !== "123456") {
           return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      delete body.newPassword;
      delete body.currentPassword;
    }

    if (Object.prototype.hasOwnProperty.call(body, "oidcClientSecret")) {
      if (!body.oidcClientSecret || !String(body.oidcClientSecret).trim()) {
        delete body.oidcClientSecret;
      }
    }

    // Validate universal tools mode at the trust boundary: only "auto" | "off".
    // Reject anything else instead of persisting a value that would break the
    // runtime type checks downstream.
    if (Object.prototype.hasOwnProperty.call(body, "universalToolsMode")) {
      // Env-set is authoritative: refuse PATCH so the toggle can't fight the
      // env kill-switch (MEDIUM #3) — the UI disables it via universalToolsLockedByEnv.
      if (universalToolsLockedByEnv()) {
        return NextResponse.json(
          { error: "universalToolsMode is locked by the UNIVERSAL_TOOLS_MODE env var" },
          { status: 403 }
        );
      }
      const mode = String(body.universalToolsMode).toLowerCase();
      if (mode !== "auto" && mode !== "off") {
        return NextResponse.json({ error: "universalToolsMode must be 'auto' or 'off'" }, { status: 400 });
      }
      body.universalToolsMode = mode;
    }

    const settings = await updateSettings(body);

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "claudeAutoPing") ||
      Object.prototype.hasOwnProperty.call(body, "codexAutoPing")
    ) {
      // Run once immediately after opt-in changes so users don't wait for the next scheduler tick.
      runQuotaAutoPingTick().catch((error) => {
        console.warn("[AutoPing] settings-triggered tick failed:", error.message);
      });
    }

    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    // Align PATCH response with GET effective mode so the UI doesn't drift
    // (single source of truth: resolveUniversalToolsMode).
    safeSettings.universalToolsMode = resolveUniversalToolsMode(safeSettings.universalToolsMode);
    safeSettings.universalToolsLockedByEnv = universalToolsLockedByEnv();
    return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
