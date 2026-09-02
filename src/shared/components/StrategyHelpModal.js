"use client";

import { useState, useMemo } from "react";
import { Modal } from "./Modal";
import { Badge } from "./Badge";

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
    tagline: "Sub-linear latency minimization without lock contention",
    category: "performance",
    categoryLabel: "Performance",
    badgeVariant: "warning",
    summary: "Randomly samples two candidate models from your combo pool and picks the one with lower active load and latency. Highly effective algorithm used by nginx and envoy.",
    howItWorks: "Samples `min(randomA, randomB)` across active models, breaking ties by latency history. Avoids herd behavior without requiring expensive global synchronization.",
    bestFor: "High-throughput production APIs, multi-user web apps, and low-latency chatbots where rapid response times are critical.",
    tips: "Works best with combos containing 3 or more models of comparable speed."
  },
  {
    id: "reset-aware",
    icon: "📊",
    name: "Reset-Aware",
    tagline: "Synchronize traffic with provider rate-limit windows",
    category: "cost",
    categoryLabel: "Cost & Quota",
    badgeVariant: "purple",
    summary: "Divides time into quota reset windows (e.g. 5-minute slots) and rotates traffic accordingly to maximize rate-limit refresh cycles across free and tier-limited providers.",
    howItWorks: "Calculates current time-slot index `Math.floor(Date.now() / 5min) % models.length`. Shifts traffic before providers throttle your tokens.",
    bestFor: "Free-tier combos (e.g. OpenRouter Free, B.AI, Cloudflare, TokenRouter) where providers impose strict RPM or hourly token limits that refresh periodically.",
    tips: "Ideal for `9-free` and background automation pipelines."
  },
  {
    id: "cost-optimized",
    icon: "💰",
    name: "Cost-Optimized",
    tagline: "Prioritize lowest token cost first",
    category: "cost",
    categoryLabel: "Cost & Quota",
    badgeVariant: "success",
    summary: "Dynamically evaluates input and output token pricing for all models in the combo and routes to the lowest-cost or free endpoint first.",
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
    summary: "Inspects live rate-limit telemetry headers (`x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens`) and dynamically chooses the provider with the safest headroom margin.",
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
    summary: "Tracks active concurrent connections in real-time and routes the incoming request to the model currently handling the fewest active requests.",
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
    summary: "Statistically distributes requests uniformly across all healthy models in the combo with equal probability.",
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

export function StrategyHelpModal({ isOpen, onClose, selectedStrategy, onSelectStrategy }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");

  const categories = [
    { id: "all", label: "All Strategies", count: STRATEGY_DETAILS.length },
    { id: "reliability", label: "Reliability & Failover", count: STRATEGY_DETAILS.filter(s => s.category === "reliability").length },
    { id: "performance", label: "Performance & Caching", count: STRATEGY_DETAILS.filter(s => s.category === "performance").length },
    { id: "cost", label: "Cost & Quota", count: STRATEGY_DETAILS.filter(s => s.category === "cost").length },
    { id: "advanced", label: "Advanced AI", count: STRATEGY_DETAILS.filter(s => s.category === "advanced").length }
  ];

  const filteredStrategies = useMemo(() => {
    return STRATEGY_DETAILS.filter(item => {
      const matchesCategory = activeCategory === "all" || item.category === activeCategory;
      const query = searchQuery.toLowerCase().trim();
      const matchesSearch = !query ||
        item.name.toLowerCase().includes(query) ||
        item.tagline.toLowerCase().includes(query) ||
        item.summary.toLowerCase().includes(query) ||
        item.bestFor.toLowerCase().includes(query);
      return matchesCategory && matchesSearch;
    });
  }, [activeCategory, searchQuery]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Load Balancing & Failover Strategies Guide"
      size="xl"
    >
      <div className="flex flex-col gap-4">
        {/* Header Intro */}
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-3.5 text-xs text-text-muted">
          <div className="flex items-center gap-2 font-medium text-primary text-sm mb-1">
            <span className="material-symbols-outlined text-[18px]">hub</span>
            <span>How Combos Manage Routing & Fault Tolerance</span>
          </div>
          <p className="leading-relaxed">
            Combos allow you to group multiple models under a single identifier. Choose the strategy that best matches your workflow requirements—whether you need zero-downtime reliability, maximum prompt cache hits, or multi-model AI synthesis.
          </p>
        </div>

        {/* Search & Category Filter Controls */}
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
          {/* Categories Tab Bar */}
          <div className="flex flex-wrap items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
            {categories.map(cat => (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${
                  activeCategory === cat.id
                    ? "bg-primary text-white shadow-sm"
                    : "bg-sidebar hover:bg-black/5 dark:hover:bg-white/5 text-text-muted border border-border/50"
                }`}
              >
                <span>{cat.label}</span>
                <span className={`text-[10px] rounded-full px-1.5 py-0.2 ${
                  activeCategory === cat.id ? "bg-white/20 text-white" : "bg-black/10 dark:bg-white/10 text-text-muted"
                }`}>
                  {cat.count}
                </span>
              </button>
            ))}
          </div>

          {/* Search Input */}
          <div className="relative w-full sm:w-60">
            <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[16px]">
              search
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search strategy..."
              className="w-full rounded-lg border border-border/70 bg-sidebar pl-8 pr-3 py-1.5 text-xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary transition-all"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text transition-colors"
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            )}
          </div>
        </div>

        {/* Strategy Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[58vh] overflow-y-auto pr-1">
          {filteredStrategies.length === 0 ? (
            <div className="col-span-full py-10 text-center text-text-muted">
              <span className="material-symbols-outlined text-4xl mb-2 text-text-muted/40">search_off</span>
              <p className="text-sm">No strategies match &ldquo;{searchQuery}&rdquo;</p>
            </div>
          ) : (
            filteredStrategies.map((item) => {
              const isSelected = selectedStrategy === item.id;
              return (
                <div
                  key={item.id}
                  className={`flex flex-col justify-between rounded-xl border p-3.5 transition-all ${
                    isSelected
                      ? "border-primary bg-primary/5 ring-1 ring-primary shadow-sm"
                      : "border-border/70 bg-card hover:border-primary/40 hover:bg-black/[0.01] dark:hover:bg-white/[0.02]"
                  }`}
                >
                  <div className="flex flex-col gap-2">
                    {/* Top Header */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xl" role="img" aria-label={item.name}>{item.icon}</span>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <h4 className="font-semibold text-sm text-text">{item.name}</h4>
                            {isSelected && (
                              <span className="inline-flex items-center rounded-full bg-primary/10 px-1.5 py-0.2 text-[10px] font-medium text-primary border border-primary/20">
                                Active
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-text-muted leading-tight">{item.tagline}</p>
                        </div>
                      </div>
                      <Badge variant={item.badgeVariant} size="sm">
                        {item.categoryLabel}
                      </Badge>
                    </div>

                    {/* Summary */}
                    <p className="text-xs text-text-muted leading-relaxed mt-1">
                      {item.summary}
                    </p>

                    {/* Details Box */}
                    <div className="rounded-lg bg-black/5 dark:bg-white/5 p-2.5 flex flex-col gap-1.5 text-[11px] mt-1 border border-border/40">
                      <div>
                        <span className="font-medium text-text">🎯 Best For: </span>
                        <span className="text-text-muted">{item.bestFor}</span>
                      </div>
                      <div>
                        <span className="font-medium text-text">⚙️ Mechanism: </span>
                        <span className="text-text-muted">{item.howItWorks}</span>
                      </div>
                      {item.tips && (
                        <div className="pt-1 border-t border-border/30 text-[10px] text-primary/90 flex items-center gap-1">
                          <span className="material-symbols-outlined text-[13px] shrink-0">tips_and_updates</span>
                          <span>{item.tips}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Optional Select Button if handler provided */}
                  {onSelectStrategy && (
                    <div className="mt-3 pt-2.5 border-t border-border/40 flex justify-end">
                      <button
                        onClick={() => {
                          onSelectStrategy(item.id);
                          onClose();
                        }}
                        disabled={isSelected}
                        className={`inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                          isSelected
                            ? "bg-primary/10 text-primary cursor-default"
                            : "bg-primary text-white hover:bg-primary/90 shadow-sm"
                        }`}
                      >
                        <span className="material-symbols-outlined text-[14px]">
                          {isSelected ? "check" : "check_circle"}
                        </span>
                        <span>{isSelected ? "Selected" : `Use ${item.name}`}</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer info */}
        <div className="flex items-center justify-between border-t border-border/60 pt-3 text-[11px] text-text-muted">
          <span className="flex items-center gap-1">
            <span className="material-symbols-outlined text-[14px] text-primary">verified</span>
            <span>All 10 strategies are active and fully supported in 888router</span>
          </span>
          <button
            onClick={onClose}
            className="rounded-lg bg-sidebar border border-border/60 px-3 py-1 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
