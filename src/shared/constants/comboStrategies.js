// Combo strategy metadata, shared by the combos page select, the help modal,
// and tests. Kept in constants (not in the JSX component) so a plain-import
// test can assert UI↔backend parity without pulling in React.
//
// `planned: true` marks a strategy the UI documents but the gateway does NOT
// implement — selecting one silently degraded to plain list order, so the
// dashboard read as "working" while the combo ran fallback. Those entries stay
// listed for transparency but cannot be selected.

export const STRATEGY_DETAILS = [
  {
    id: "fallback",
    icon: "🥇",
    name: "Priority Fallback",
    tagline: "Try models in exact sequential order",
    category: "reliability",
    categoryLabel: "Reliability",
    badgeVariant: "primary",
    summary: "Always sends requests to the first model in your list. If that model encounters rate limits (429), server errors (500), or timeouts, traffic automatically cascades to the next fallback model immediately.",
    howItWorks: "Evaluates Model 1 → on failure, retries Model 2 → on failure, retries Model 3. Transparent failover with zero connection drops.",
    bestFor: "Prioritizing your most capable flagship model (e.g. Claude Opus / Sonnet) while having resilient free or fast fallbacks ready when quotas exhaust.",
    tips: "Place your highest-intelligence model at position #1, followed by lower-cost or free fallbacks."
  },
  {
    id: "round-robin",
    icon: "🔄",
    name: "Round Robin",
    tagline: "Distribute requests evenly in cyclic order",
    category: "performance",
    categoryLabel: "Load Balancing",
    badgeVariant: "info",
    summary: "Cycles through all healthy models in your combo list sequentially (Model 1 → Model 2 → Model 3 → Model 1). Supports sticky sessions to keep multi-turn conversations on the same model for N turns.",
    howItWorks: "Maintains an in-memory rotation pointer per combo. When Sticky Limit is set (e.g. 5 requests), each model handles 5 consecutive turns before rotating to the next.",
    bestFor: "Pooling rate limits across multiple identical accounts or providers (e.g. multiple Kiro, Anthropic, or Ollama keys) to prevent any single account from hitting RPM/TPM ceilings.",
    tips: "Combine with Sticky Limit = 3-5 if your clients send multi-step chat turns."
  },
  {
    id: "cache-optimized",
    icon: "🎯",
    name: "Cache-Optimized",
    tagline: "Deterministic prompt hashing for 90%+ prompt cache hits",
    category: "performance",
    categoryLabel: "Performance",
    badgeVariant: "success",
    summary: "Computes a deterministic hash of the system instructions and prompt prefix, consistently pinning identical prompt contexts to the same upstream model instance.",
    howItWorks: "Extracts system prompt and early message history → computes 32-bit FNV hash → routes to `hash % models.length`. Same project context always reaches the same provider.",
    bestFor: "AI Coding Agents (Claude Code, Hermes, Antigravity, Cursor) with large system prompts, workspace rules, and repository context where prompt cache hits slash latency by up to 90%.",
    tips: "Ensure all models in the combo have similar capabilities so any hashed target delivers top results."
  },
  {
    id: "p2c",
    icon: "⚡",
    name: "P2C (Power-of-Two-Choices)",
    tagline: "Randomized pick across two sampled positions",
    category: "performance",
    categoryLabel: "Performance",
    badgeVariant: "warning",
    summary: "Randomly samples two positions in your combo list and starts from the earlier one. The gateway does NOT read upstream load or latency — this is a rotation heuristic, not a measured latency minimiser.",
    howItWorks: "Picks `min(randomA, randomB)` as the starting index, then rotates from there. Because the minimum of two uniform samples skews toward the head of the list, early models receive more traffic than later ones.",
    bestFor: "Combos where you want some variance in which model starts, and the head of the list is an acceptable default.",
    tips: "Put your strongest model at position #1 — P2C biases traffic toward the front of the list."
  },
  {
    id: "reset-aware",
    icon: "📊",
    name: "Reset-Aware",
    tagline: "Rotate the starting model on a 5-minute wall-clock slot",
    category: "cost",
    categoryLabel: "Cost & Quota",
    badgeVariant: "purple",
    summary: "Divides time into 5-minute slots and rotates which model starts each slot. The gateway does NOT read provider quota headers or reset timestamps — the window is fixed, not derived from any provider.",
    howItWorks: "Computes `Math.floor(Date.now() / 5min) % models.length` and rotates the list from that index. With N models each starting model leads for a fixed slice of wall-clock time.",
    bestFor: "Free-tier combos where evenly spreading traffic over time matters more than any specific provider's reset schedule.",
    tips: "Rotation is deterministic — use Round Robin instead if you want per-request alternation."
  },
  {
    id: "cost-optimized",
    icon: "💰",
    name: "Cost-Optimized",
    tagline: "Prioritize lowest token cost first",
    category: "cost",
    categoryLabel: "Cost & Quota",
    badgeVariant: "success",
    planned: true,
    summary: "Planned — not yet implemented in the gateway; selecting is disabled. Dynamically evaluates input and output token pricing for all models in the combo and routes to the lowest-cost or free endpoint first.",
    howItWorks: "Checks model pricing metadata from providers registry and sorts models ascending by token cost before attempting execution.",
    bestFor: "High-volume batch jobs, text summarization, data extraction, and cost-sensitive applications where preserving premium credits is paramount.",
    tips: "Add both premium and cheap/free models in the combo; expensive models will act as fallback only."
  },
  {
    id: "headroom",
    icon: "🔋",
    name: "Headroom",
    tagline: "Route to provider with highest remaining quota buffer",
    category: "cost",
    categoryLabel: "Cost & Quota",
    badgeVariant: "info",
    planned: true,
    summary: "Planned — not yet implemented in the gateway; selecting is disabled. Inspects live rate-limit telemetry headers (`x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens`) and dynamically chooses the provider with the safest headroom margin.",
    howItWorks: "Continuously tracks upstream response headers and health EWMA, prioritizing models with maximum remaining capacity buffer.",
    bestFor: "Burst-heavy workloads across multiple accounts with uneven monthly quota allowances.",
    tips: "Ensure upstream providers return standard rate-limit headers for optimal scoring."
  },
  {
    id: "least-used",
    icon: "⚖️",
    name: "Least-Used",
    tagline: "Route to model with lowest concurrent in-flight requests",
    category: "performance",
    categoryLabel: "Load Balancing",
    badgeVariant: "primary",
    planned: true,
    summary: "Planned — not yet implemented in the gateway; selecting is disabled. Tracks active concurrent connections in real-time and routes the incoming request to the model currently handling the fewest active requests.",
    howItWorks: "Increments in-flight counter on request start and decrements on completion. Always dispatches to `min(activeRequests)`.",
    bestFor: "Multi-user shared proxy setups and concurrent agent swarms to prevent overloading any single model connection.",
    tips: "Great for local Ollama instances or self-hosted servers with finite parallel processing threads."
  },
  {
    id: "random",
    icon: "🎲",
    name: "Random",
    tagline: "Uniform random load balancing across all members",
    category: "performance",
    categoryLabel: "Load Balancing",
    badgeVariant: "default",
    planned: true,
    summary: "Planned — not yet implemented in the gateway; selecting is disabled. Statistically distributes requests uniformly across all healthy models in the combo with equal probability.",
    howItWorks: "Selects `Math.floor(Math.random() * models.length)` on every request. Completely stateless and zero overhead.",
    bestFor: "Simple multi-endpoint distribution where all models in the combo have identical pricing, speed, and capabilities.",
    tips: "Use when you have multiple mirror endpoints of the same model."
  },
  {
    id: "fusion",
    icon: "🧬",
    name: "Fusion (Panel of Experts)",
    tagline: "Concurrent multi-model fan-out with AI Judge synthesis",
    category: "advanced",
    categoryLabel: "Advanced AI",
    badgeVariant: "purple",
    summary: "Dispatches the prompt to all panel models in parallel, collects their distinct reasoning paths, and feeds them to an AI Judge Model to evaluate, cross-check, and synthesize the ultimate answer.",
    howItWorks: "Fan-out: Request → [Model A, Model B, Model C] concurrently → Aggregator receives 3 completions → Judge Prompt sends all 3 answers to Judge Model → Streams final synthesized masterpiece.",
    bestFor: "Critical code reviews, complex architectural decisions, scientific analysis, and edge-case validation where accuracy is far more important than token cost.",
    tips: "Pick an advanced reasoning model (e.g. Claude Opus 5 or Gemini Pro) as your Judge Model for highest synthesis quality."
  }
];

// Strategies the gateway actually implements. `planned: true` entries above are
// roadmap items only — shown for transparency but not selectable, because the
// backend silently degraded them to plain list order while the UI claimed they
// were active.
export const ACTIVE_STRATEGY_COUNT = STRATEGY_DETAILS.filter((s) => !s.planned).length;

// Values persisted into settings.comboStrategies[name].fallbackStrategy.
// Keep in sync with STRATEGY_OPTIONS in the combos page and with
// COMBO_ROTATION_STRATEGIES (+ the `fusion` branch) in open-sse/services/combo.js.
export const ACTIVE_STRATEGY_IDS = STRATEGY_DETAILS.filter((s) => !s.planned).map((s) => s.id);
