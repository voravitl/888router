/**
 * Built-in Auto Combo Catalog & Template Definitions
 */

export const AUTO_COMBO_TEMPLATES = [
  {
    name: "auto/best-coding",
    displayName: "Best Coding",
    categories: ["coding"],
    tiers: ["pro", "fast"],
    strategy: "round-robin",
    description: "Routes to highest performance coding models across active connections",
  },
  {
    name: "auto/best-reasoning",
    displayName: "Best Reasoning",
    categories: ["reasoning"],
    tiers: ["pro"],
    strategy: "round-robin",
    description: "Routes to deep thinking and reasoning models",
  },
  {
    name: "auto/best-fast",
    displayName: "Best Fast",
    categories: ["chat", "fast"],
    tiers: ["fast"],
    strategy: "p2c",
    description: "Lowest latency inference using Power-of-Two-Choices sampling",
  },
  {
    name: "auto/best-vision",
    displayName: "Best Vision",
    categories: ["vision", "multimodal"],
    tiers: ["pro", "fast"],
    strategy: "round-robin",
    description: "Routes to high-capability multimodal vision models",
  },
  {
    name: "auto/best-free",
    displayName: "Best Free",
    categories: ["chat", "coding"],
    tiers: ["free"],
    strategy: "reset-aware",
    description: "Routes across all free tiers, prioritizing models closest to quota reset",
  },
  {
    name: "auto/cheap",
    displayName: "Most Economical",
    categories: ["chat"],
    tiers: ["cheap", "free"],
    strategy: "reset-aware",
    description: "Routes to lowest-cost or free models",
  },
];

export const AUTO_TEMPLATE_VARIANTS = {
  "auto/best-coding": { category: "coding", tier: "pro" },
  "auto/best-reasoning": { category: "reasoning", tier: "pro" },
  "auto/best-fast": { category: "chat", tier: "fast", strategy: "p2c" },
  "auto/best-vision": { category: "vision", tier: "pro" },
  "auto/best-free": { category: "chat", tier: "free", strategy: "reset-aware" },
  "auto/cheap": { category: "chat", tier: "cheap", strategy: "reset-aware" },
  "auto/coding": { category: "coding", tier: "pro" },
  "auto/fast": { category: "chat", tier: "fast", strategy: "p2c" },
};
