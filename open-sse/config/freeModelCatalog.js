export { FREE_MODEL_BUDGETS, FREE_CATALOG_CURATED_AT } from "./freeModelCatalog.data.js";
import { FREE_MODEL_BUDGETS } from "./freeModelCatalog.data.js";

export const FREE_REGIME_TRAITS = {
  "recurring-daily": {
    grantsFreeAccess: true,
    tokenBucket: "steady-monthly",
    allowsNoAuthShortcut: false,
  },
  "recurring-monthly": {
    grantsFreeAccess: true,
    tokenBucket: "steady-monthly",
    allowsNoAuthShortcut: false,
  },
  "recurring-credit": {
    grantsFreeAccess: true,
    tokenBucket: "recurring-credit",
    allowsNoAuthShortcut: false,
  },
  "recurring-uncapped": {
    grantsFreeAccess: true,
    tokenBucket: "uncapped",
    allowsNoAuthShortcut: false,
  },
  "one-time-initial": {
    grantsFreeAccess: true,
    tokenBucket: "one-time-credit",
    allowsNoAuthShortcut: false,
  },
  keyless: {
    grantsFreeAccess: true,
    tokenBucket: "steady-monthly",
    allowsNoAuthShortcut: true,
  },
  discontinued: {
    grantsFreeAccess: false,
    tokenBucket: "none",
    allowsNoAuthShortcut: false,
  },
};

export function grantsFreeAccess(freeType) {
  return FREE_REGIME_TRAITS[freeType]?.grantsFreeAccess ?? false;
}

export function freeTypesInBucket(bucket) {
  return new Set(
    Object.keys(FREE_REGIME_TRAITS).filter(
      (freeType) => FREE_REGIME_TRAITS[freeType].tokenBucket === bucket
    )
  );
}

export function allowsNoAuthShortcut(freeType) {
  return FREE_REGIME_TRAITS[freeType]?.allowsNoAuthShortcut ?? false;
}

const STEADY_MONTHLY = freeTypesInBucket("steady-monthly");
const RECURRING_CREDIT = freeTypesInBucket("recurring-credit");
const ONE_TIME_CREDIT = freeTypesInBucket("one-time-credit");
const UNCAPPED = freeTypesInBucket("uncapped");

export const FREE_TIER_BOOSTS = {
  "openrouter-free": {
    provider: "openrouter",
    boostMonthlyTokens: 24_000_000,
    note: "A one-time $10 lifetime top-up raises the free pool from 50 to 1000 requests/day (~24M tokens/month).",
  },
};

function fmt(n) {
  return n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : Math.round(n / 1e6) + "M";
}

function dedupedSum(models, pick, include) {
  const poolMax = new Map();
  let loose = 0;
  for (const m of models) {
    if (!include(m)) continue;
    const key = m.poolKey;
    if (key) poolMax.set(key, Math.max(poolMax.get(key) ?? 0, pick(m)));
    else loose += pick(m);
  }
  for (const v of poolMax.values()) loose += v;
  return loose;
}

export function computeFreeModelTotals(opts = {}) {
  const catalog = opts.entries ?? FREE_MODEL_BUDGETS;
  const models = catalog.filter(
    (m) => !(opts.excludeTosAvoid && m.tos === "avoid") && m.enabled !== false
  );

  const steadyRecurringTokens = dedupedSum(
    models,
    (m) => m.monthlyTokens,
    (m) => STEADY_MONTHLY.has(m.freeType)
  );
  const recurringCredits = dedupedSum(
    models,
    (m) => m.creditTokens,
    (m) => RECURRING_CREDIT.has(m.freeType)
  );
  const oneTimeCredits = dedupedSum(
    models,
    (m) => m.creditTokens,
    (m) => ONE_TIME_CREDIT.has(m.freeType)
  );

  const steadyWithRecurringCreditsTokens = steadyRecurringTokens + recurringCredits;
  const firstMonthRealisticTokens = steadyWithRecurringCreditsTokens + oneTimeCredits;

  const poolCount = new Set(
    models.filter((m) => STEADY_MONTHLY.has(m.freeType) && m.poolKey).map((m) => m.poolKey)
  ).size;

  const livePools = new Set(
    models.filter((m) => STEADY_MONTHLY.has(m.freeType) && m.poolKey).map((m) => m.poolKey)
  );
  const boostMonthlyTokens = Object.entries(FREE_TIER_BOOSTS)
    .filter(([pool]) => livePools.has(pool))
    .reduce((s, [, b]) => s + b.boostMonthlyTokens, 0);

  const uncappedProviders = [
    ...new Set(models.filter((m) => UNCAPPED.has(m.freeType)).map((m) => m.provider)),
  ].sort();

  return {
    steadyRecurringTokens,
    steadyWithRecurringCreditsTokens,
    firstMonthRealisticTokens,
    boostMonthlyTokens,
    uncappedProviders,
    modelCount: models.length,
    poolCount,
    perModel: models,
    headline: `~${fmt(steadyRecurringTokens)} tokens/mo permanently free across ${poolCount} independent pools (${models.length} models)`,
  };
}
