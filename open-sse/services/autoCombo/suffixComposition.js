/**
 * Suffix Composition for Auto-Combos
 * Supports expressions like:
 *   - auto/coding:fast
 *   - auto/coding:free
 *   - auto/multimodal:free
 *   - auto/reasoning:pro
 *   - auto/best-coding
 *   - auto/best-free
 */

export const AUTO_CATEGORIES = [
  "coding",
  "reasoning",
  "vision",
  "chat",
  "multimodal",
  "fast",
  "smart",
  "cheap",
];

export const AUTO_TIERS = [
  "fast",
  "cheap",
  "floor",
  "free",
  "reliable",
  "pro",
  "subscription",
  "thrifty",
];

const CATEGORY_SET = new Set(AUTO_CATEGORIES);
const TIER_SET = new Set(AUTO_TIERS);

/**
 * Parse the suffix after `auto/`
 * @param {string} suffix - e.g. "coding:fast", "best-free", "vision"
 * @returns {{ valid: boolean, category?: string, tier?: string }}
 */
export function parseAutoSuffix(suffix) {
  if (typeof suffix !== "string" || suffix.length === 0) return { valid: false };

  // Handle aliases like "best-free", "best-free-1m", "best-coding", "best-vision"
  if (suffix === "best-free-1m" || suffix === "free-1m" || suffix === "free:1m" || suffix === "best-free:1m") {
    return { valid: true, category: "chat", tier: "free", contextMin: 1000000 };
  }
  if (suffix === "best-free" || suffix === "free") {
    return { valid: true, category: "chat", tier: "free" };
  }
  if (suffix === "best-coding" || suffix === "coding") {
    return { valid: true, category: "coding", tier: "pro" };
  }
  if (suffix === "best-reasoning" || suffix === "reasoning") {
    return { valid: true, category: "reasoning", tier: "pro" };
  }
  if (suffix === "best-fast" || suffix === "fast") {
    return { valid: true, category: "chat", tier: "fast" };
  }
  if (suffix === "best-vision" || suffix === "vision" || suffix === "multimodal") {
    return { valid: true, category: "vision", tier: "pro" };
  }
  if (suffix === "cheap") {
    return { valid: true, category: "chat", tier: "cheap" };
  }

  const parts = suffix.split(":");
  if (parts.length > 2) return { valid: false };
  const [head, tail] = parts;

  if (tail !== undefined) {
    if (!CATEGORY_SET.has(head) || !TIER_SET.has(tail)) return { valid: false };
    return { valid: true, category: head, tier: tail };
  }
  if (CATEGORY_SET.has(head)) {
    return { valid: true, category: head };
  }

  return { valid: false };
}
