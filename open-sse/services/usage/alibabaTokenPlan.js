/**
 * Alibaba Token Plan (Personal, Singapore region) usage.
 *
 * The Personal plan quota is a MONTHLY credit pool — Lite 11,500 / Essential
 * 25,500 / Standard 45,000 / Pro 180,000 Credits, resetting per subscription
 * month (alibabacloud.com/help/en/model-studio/token-plan-personal-overview).
 * The 5-hour / weekly rolling windows were removed on 2026-09-22; the legacy
 * keys are still parsed when the API returns them.
 *
 * The Token Plan inference endpoint (sk-sp-* API keys) is inference-only: every
 * billing path 404s unrouted and the console gateway answers ConsoleNeedLogin
 * for keys. Usage is only served by the Model Studio console personal panel,
 * reached with the browser session cookie — stored in
 * `providerSpecificData.consoleCookie` (pasted by the user, never returned to
 * the browser: the providers API strips it).
 *
 * Wire contract below was captured from the live intl-personal console
 * (bailian-singapore-cs.alibabacloud.com, action=IntlBroadScopeAspnGateway,
 * product=sfm_bailian) — the same gateway the console's My Subscriptions page
 * calls. `cornerstoneParam` must be present in `params` but its contents are
 * not validated; it must NOT pin a `switchAgent` (that field binds the call
 * to one account's workspace and every other account fails with
 * Workspace.NotAuthorised).
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { fetchWithTimeout, parseResetTime, toFiniteNumber } from "./shared.js";

const GATEWAY_URL = "https://bailian-singapore-cs.alibabacloud.com/data/api.json";
const CONSOLE_ORIGIN = "https://modelstudio.console.alibabacloud.com";
const DASHBOARD_URL = `${CONSOLE_ORIGIN}/ap-southeast-1/?tab=plan#/efm/subscription/token-plan/personal`;
const USER_INFO_URL = `${CONSOLE_ORIGIN}/tool/user/info.json`;
const REGION = "ap-southeast-1";
const ACTION = "IntlBroadScopeAspnGateway";
const PRODUCT = "sfm_bailian";
const CONSOLE_SITE = "MODELSTUDIO_ALBABACLOUD"; // live console contract (incl. historical spelling)
const DOMAIN = "modelstudio.console.alibabacloud.com";
const PERSONAL_API_BASE = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2";
const USAGE_API = `${PERSONAL_API_BASE}/usage`;
const SUBSCRIPTION_API = `${PERSONAL_API_BASE}/subscription`;
const QUOTA_CONFIG_API = `${PERSONAL_API_BASE}/quota-config`;

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Safari/605.1.15";

// Official Personal-edition monthly quotas (credits), used when the API's
// quota-config is unreachable. Source: token-plan-personal-overview doc.
const MONTHLY_QUOTA_BY_TIER = {
  lite: 11500,
  essential: 25500,
  standard: 45000,
  pro: 180000,
};

// quota-config keys are snake_case; the window defs use camelCase.
const QUOTA_CONFIG_KEYS = { fiveHour: "five_hour", weekly: "weekly", monthly: "monthly" };
const WINDOW_DEFS = [
  { key: "per5HourPercentage", resetKey: "per5HourResetTime", label: "5 Hours (rolling)", quotaKey: "fiveHour" },
  { key: "per1WeekPercentage", resetKey: "per1WeekResetTime", label: "Weekly", quotaKey: "weekly" },
  { key: "per1MonthPercentage", resetKey: "per1MonthResetTime", label: "Monthly", quotaKey: "monthly" },
];

/**
 * The gateway nests payloads as `data.DataV2.data.data`, and some levels arrive
 * as JSON-encoded strings (observed in the live Qwen/Model Studio envelopes).
 * Expand embedded JSON strings recursively so one walker finds every object.
 */
export function expandEmbeddedJSON(value, depth = 0) {
  if (depth > 6) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
    try {
      return expandEmbeddedJSON(JSON.parse(trimmed), depth + 1);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandEmbeddedJSON(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = expandEmbeddedJSON(item, depth + 1);
    }
    return out;
  }
  return value;
}

/** Depth-first search for the first object containing any of `keys`. */
export function findObjectWithKeys(node, keys, depth = 0) {
  if (depth > 8 || !node || typeof node !== "object") return null;
  if (!Array.isArray(node)) {
    if (keys.some((key) => node[key] !== undefined)) return node;
    for (const value of Object.values(node)) {
      const hit = findObjectWithKeys(value, keys, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const value of node) {
    const hit = findObjectWithKeys(value, keys, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function extractCookieValue(header, name) {
  if (typeof header !== "string") return null;
  const match = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
}

function formBody(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    params.set(key, String(value));
  }
  return params.toString();
}

function cornerstoneParam() {
  return {
    feTraceId: crypto.randomUUID().toLowerCase(),
    feURL: DASHBOARD_URL,
    protocol: "V2",
    console: "ONE_CONSOLE",
    productCode: "p_efm",
    switchUserType: 3,
    domain: DOMAIN,
    consoleSite: CONSOLE_SITE,
    userNickName: "",
    userPrincipalName: "",
    xsp_lang: "en-US",
  };
}

function gatewayBody(api, dataParameters, cookie, secToken) {
  const data = { ...dataParameters, cornerstoneParam: cornerstoneParam() };
  const cna = extractCookieValue(cookie, "cna");
  if (cna) data.cornerstoneParam["X-Anonymous-Id"] = cna;
  const params = JSON.stringify({ Api: api, V: "1.0", Data: data });
  const fields = {
    product: PRODUCT,
    action: ACTION,
    region: REGION,
    language: "en-US",
    params,
  };
  if (secToken) fields.sec_token = secToken;
  return formBody(fields);
}

const SEC_TOKEN_PATTERNS = [
  /"secToken"\s*:\s*"([^"]+)"/,
  /"sec_token"\s*:\s*"([^"]+)"/,
  /secToken['"]?\s*[:=]\s*['"]([^'"]+)['"]/,
  /sec_token['"]?\s*[:=]\s*['"]([^'"]+)['"]/,
  // OneConsole embeds `SEC_TOKEN: "<token>"` (upper-case, unquoted key) inside
  // window.ALIYUN_CONSOLE_CONFIG.
  /SEC_TOKEN['"]?\s*[:=]\s*['"]([^'"]+)['"]/,
];

function extractSecTokenFromHtml(html) {
  for (const pattern of SEC_TOKEN_PATTERNS) {
    const match = typeof html === "string" ? html.match(pattern) : null;
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Best-effort sec_token: tool/user/info.json → user/info cookie → dashboard HTML. Never throws. */
async function resolveSecToken(cookie, proxyOptions) {
  // 1) Small JSON endpoint — cheapest place to find it.
  try {
    const response = await fetchWithTimeout(
      USER_INFO_URL,
      {
        method: "GET",
        headers: { Cookie: cookie, "User-Agent": BROWSER_UA, Accept: "application/json, text/plain, */*", Referer: CONSOLE_ORIGIN },
      },
      8000,
      proxyOptions,
    );
    if (response?.ok) {
      const text = await response.text().catch(() => "");
      try {
        const expanded = expandEmbeddedJSON(JSON.parse(text));
        const token = findObjectWithKeys(expanded, ["secToken", "sec_token"]);
        const found = token?.secToken ?? token?.sec_token;
        if (typeof found === "string" && found) return found;
      } catch {
        // fall through to next source
      }
    }
  } catch {
    // best-effort only
  }

  // 2) Cookie itself carries a sec_token session value.
  const cookieToken = extractCookieValue(cookie, "sec_token");
  if (cookieToken) return cookieToken;

  // 3) Dashboard HTML scrape. The OneConsole shell only server-renders
  // SEC_TOKEN for a same-origin navigation, so send browser-nav headers.
  try {
    const response = await fetchWithTimeout(
      DASHBOARD_URL,
      {
        method: "GET",
        headers: {
          Cookie: cookie,
          "User-Agent": SAFARI_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Referer: `${CONSOLE_ORIGIN}/`,
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
      10000,
      proxyOptions,
    );
    if (response?.ok) {
      const html = await response.text().catch(() => "");
      const token = extractSecTokenFromHtml(html);
      if (token) return token;
    }
  } catch {
    // best-effort only
  }

  return null;
}

/** Login-shaped errors can appear nested anywhere in the envelope; find them. */
function findErrorPayload(expanded) {
  if (!expanded || typeof expanded !== "object") return null;
  const queue = [expanded];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== "object") continue;
    const code = typeof node.errorCode === "string" ? node.errorCode : typeof node.code === "string" ? node.code : undefined;
    const msg = typeof node.errorMsg === "string" ? node.errorMsg : typeof node.message === "string" ? node.message : undefined;
    const failed = node.success === false || node.Success === false;
    if (failed || (code && /login|needlogin|tokenerror|postonly/i.test(code))) {
      return { code, msg };
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return null;
}

const isLoginError = (code, msg) => /login|needlogin/i.test(`${code ?? ""} ${msg ?? ""}`);

/** POST one personal API; classify errors. Throws only on network failure. */
async function callPersonalApi(api, dataParameters, cookie, secToken, proxyOptions) {
  const csrf = extractCookieValue(cookie, "login_aliyunid_csrf") ?? extractCookieValue(cookie, "csrf");
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json, text/plain, */*",
    Cookie: cookie,
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": BROWSER_UA,
    Origin: CONSOLE_ORIGIN,
    Referer: DASHBOARD_URL,
  };
  if (csrf) {
    headers["x-xsrf-token"] = csrf;
    headers["x-csrf-token"] = csrf;
  }

  const query = new URLSearchParams({ action: ACTION, product: PRODUCT, api, _v: "undefined" });
  const response = await proxyAwareFetch(`${GATEWAY_URL}?${query.toString()}`, {
    method: "POST",
    headers,
    body: gatewayBody(api, dataParameters, cookie, secToken),
  }, proxyOptions);

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      const error = new Error("Model Studio console rejected the cookie (HTTP " + response.status + ")");
      error.login = true;
      throw error;
    }
    throw new Error(`Model Studio console error (HTTP ${response.status})`);
  }

  const text = await response.text().catch(() => "");
  let expanded;
  try {
    expanded = expandEmbeddedJSON(JSON.parse(text));
  } catch {
    // A stale console session can come back as an HTML login page with HTTP
    // 200 (observed on the mainland personal gateway) — treat it as a login
    // failure, not a generic parse error.
    const looksLikeLogin = /<html/i.test(text) && /login|sign[\s-]?in/i.test(text);
    const error = new Error("Model Studio console returned a non-JSON response");
    if (looksLikeLogin) error.login = true;
    throw error;
  }

  const errorPayload = findErrorPayload(expanded);
  if (errorPayload) {
    const error = new Error(
      errorPayload.msg || errorPayload.code || "Token Plan quota API returned an error",
    );
    if (isLoginError(errorPayload.code, errorPayload.msg)) error.login = true;
    throw error;
  }

  return expanded;
}

function tierFromSubscription(expanded) {
  const sub = findObjectWithKeys(expanded, ["specCode", "spec_code", "planName", "plan_name"]);
  const raw = sub?.specCode ?? sub?.spec_code ?? sub?.planName ?? sub?.plan_name;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.trim().toLowerCase();
}

function displayTier(tier) {
  if (!tier) return null;
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

function ratioOf(value) {
  const n = toFiniteNumber(value, Number.NaN);
  if (!Number.isFinite(n)) return null;
  // The API reports fractions of 1.0 (0.25 = 25% used); values outside [0, 1]
  // are clamped the same way the console's own fetcher clamps them.
  return Math.min(1, Math.max(0, n));
}

function buildWindowRows(usageNode, quotaNode, tier) {
  const quotas = {};
  for (const { key, resetKey, label, quotaKey } of WINDOW_DEFS) {
    const ratio = ratioOf(usageNode?.[key]);
    if (ratio === null) continue;
    const remainingPct = Math.max(0, Math.min(100, Math.round((1 - ratio) * 100)));
    const configKey = QUOTA_CONFIG_KEYS[quotaKey];
    const tierNode = quotaNode && tier ? quotaNode?.[tier] : null;
    const quotaTotal = tierNode && typeof tierNode === "object"
      ? toFiniteNumber(tierNode[configKey], Number.NaN)
      : Number.NaN;
    const total = Number.isFinite(quotaTotal) && quotaTotal > 0
      ? quotaTotal
      : quotaKey === "monthly"
        ? MONTHLY_QUOTA_BY_TIER[tier] ?? 0
        : 0;
    // A row with no known total is not a quota reading: the card treats
    // total 0 as "unlimited" and divides by it (NaN%), so skip it and let the
    // caller report the unresolved tier instead.
    if (!(total > 0)) continue;
    const used = Math.round(total * ratio);
    quotas[label] = {
      name: label,
      used,
      total,
      remaining: Math.max(0, total - used),
      remainingPercentage: remainingPct,
      unit: "credits",
      resetAt: parseResetTime(usageNode?.[resetKey]) ?? null,
    };
  }
  return quotas;
}

/**
 * Fetch Alibaba Token Plan Personal quota.
 * @param {object|undefined} providerSpecificData - connection PSD; reads consoleCookie
 * @param {object|null} proxyOptions - proxy pool options passed to proxyAwareFetch
 * @returns {Promise<{plan?: string, quotas?: object, message?: string}>}
 */
export async function getAlibabaTokenPlanUsage(providerSpecificData, proxyOptions = null) {
  const cookie = typeof providerSpecificData?.consoleCookie === "string"
    ? providerSpecificData.consoleCookie.trim()
    : "";
  if (!cookie) {
    return {
      message:
        "Alibaba Token Plan quota needs the Model Studio console cookie. " +
        "Open the Token Plan subscription page in your browser, copy the Cookie header, " +
        "and paste it under “Console Cookie (quota)” in the connection settings.",
    };
  }

  let secToken = null;
  try {
    secToken = await resolveSecToken(cookie, proxyOptions);
  } catch {
    secToken = null; // best-effort; the API may work cookie-only
  }

  // Subscription + quota-config are enrichments — never fail the whole fetch.
  const [subscriptionBody, quotaConfigBody] = await Promise.all([
    callPersonalApi(SUBSCRIPTION_API, { commodityCode: "sfm_tokenplansolo_public_intl" }, cookie, secToken, proxyOptions).catch(() => null),
    callPersonalApi(QUOTA_CONFIG_API, {}, cookie, secToken, proxyOptions).catch(() => null),
  ]);
  const tier = (subscriptionBody && tierFromSubscription(subscriptionBody)) || null;

  // Usage is required; retry once on an empty/transient payload.
  let usageBody = null;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      usageBody = await callPersonalApi(USAGE_API, {}, cookie, secToken, proxyOptions);
      lastError = null;
      if (findObjectWithKeys(usageBody, WINDOW_DEFS.map((w) => w.key))) break;
      usageBody = null; // 200 with no windows — retry once
    } catch (error) {
      lastError = error;
      if (error?.login) break; // cookie dead — retrying is pointless
    }
  }

  if (lastError) {
    if (lastError.login) {
      return {
        message:
          "Model Studio console cookie is expired or invalid. Paste a fresh cookie from the " +
          "Token Plan subscription page in the connection settings.",
      };
    }
    return { message: `Unable to fetch Alibaba Token Plan usage: ${lastError.message}` };
  }

  const usageNode = usageBody ? findObjectWithKeys(usageBody, WINDOW_DEFS.map((w) => w.key)) : null;
  if (!usageNode) {
    return { message: "Alibaba Token Plan quota data unavailable (unexpected response shape)." };
  }

  // Raw quota-config node (per-tier object), expanded once for row building.
  let quotaConfigNode = null;
  if (quotaConfigBody) {
    quotaConfigNode = findObjectWithKeys(quotaConfigBody, tier ? [tier] : ["lite"]);
  }
  const quotas = buildWindowRows(usageNode, quotaConfigNode, tier);
  if (Object.keys(quotas).length === 0) {
    const sawRatio = WINDOW_DEFS.some(({ key }) => ratioOf(usageNode?.[key]) !== null);
    return {
      message: sawRatio
        ? "Alibaba Token Plan quota total is unknown: the console did not report the plan tier or a quota ceiling."
        : "Alibaba Token Plan quota data unavailable (unexpected response shape).",
    };
  }

  return {
    plan: tier ? `Token Plan ${displayTier(tier)}` : "Token Plan (Personal)",
    quotas,
  };
}
