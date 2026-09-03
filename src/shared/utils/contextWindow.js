/**
 * Standard power-of-two context window boundaries mapped to clean human labels.
 */
const EXACT_POW2_CONTEXT = {
  2097152: "2M",
  1048576: "1M",
  524288: "512K",
  262144: "256K",
  131072: "128K",
  65536: "64K",
  32768: "32K",
  16384: "16K",
  8192: "8K",
  4096: "4K",
};

/**
 * Format integer context window into clean human label: 1M, 200K, 128K, 32K, etc.
 * @param {number|string} num - Context window size in tokens
 * @returns {string|null} Formatted label or null
 */
export function formatContextWindow(num) {
  if (typeof num === "string") {
    const parsed = parseInt(num, 10);
    if (!isNaN(parsed)) num = parsed;
  }
  if (!num || typeof num !== "number" || isNaN(num) || num <= 0) return null;
  if (EXACT_POW2_CONTEXT[num]) return EXACT_POW2_CONTEXT[num];
  if (num >= 1000000) {
    const m = num / 1000000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (num >= 1000) {
    const k = Math.round(num / 1000);
    return `${k}K`;
  }
  return `${num}`;
}

export const CONTEXT_FILTER_OPTIONS = [
  { value: 0, label: "All Context" },
  { value: 128000, label: "≥ 128K" },
  { value: 200000, label: "≥ 200K" },
  { value: 1000000, label: "≥ 1M" },
];
