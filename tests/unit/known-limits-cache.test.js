import { describe, it, expect, beforeEach } from "vitest";

// resolveKnownLimits() memoizes the strict catalogue walk, so the cache must be
// invalidated by every writer of the dynamic caps it reads. A memo that outlives
// its input is worse than no memo: /v1/models would publish a stale context
// window forever, with no signal that anything is wrong.

const {
  resolveKnownLimits,
  resolveKnownContextWindow,
  resolveKnownMaxOutput,
  getCapabilitiesForModel,
  registerDynamicCapabilities,
  registerDynamicCapabilitiesScoped,
  __resetScopedDynamicCache,
  __resetKnownLimitsCache,
} = await import("../../open-sse/providers/capabilities.js");

describe("resolveKnownLimits — strict resolution", () => {
  beforeEach(() => {
    __resetScopedDynamicCache();
    __resetKnownLimitsCache();
  });

  it("returns real limits for a catalogue-known model", () => {
    const limits = resolveKnownLimits("openai", "gpt-4o");
    expect(limits.contextWindow).toBe(128000);
    expect(limits.maxOutput).toBe(16384);
  });

  it("returns undefined limits for a model no source knows (never the 200k/64k floor)", () => {
    const limits = resolveKnownLimits("nara", "totally-unknown-model-xyz");
    expect(limits.contextWindow).toBeUndefined();
    expect(limits.maxOutput).toBeUndefined();
    // The loose resolver still floors — that is the documented difference, and
    // the reason the strict one exists.
    expect(getCapabilitiesForModel("nara", "totally-unknown-model-xyz").contextWindow).toBe(200000);
  });

  it("keeps the single-field resolvers consistent with the combined one", () => {
    for (const model of ["gpt-4o", "claude-opus-4.7", "totally-unknown-model-xyz"]) {
      const limits = resolveKnownLimits("openai", model);
      expect(resolveKnownContextWindow("openai", model)).toBe(limits.contextWindow);
      expect(resolveKnownMaxOutput("openai", model)).toBe(limits.maxOutput);
    }
  });

  it("scopes the answer per provider so a shared bare id cannot bleed", () => {
    // Same model id, two providers: a scoped dynamic write for one must not
    // change what the other reports.
    registerDynamicCapabilitiesScoped("nara", "shared-model-id", { contextWindow: 400000 });
    expect(resolveKnownLimits("nara", "shared-model-id").contextWindow).toBe(400000);
    expect(resolveKnownLimits("other", "shared-model-id").contextWindow).not.toBe(400000);
  });
});

describe("resolveKnownLimits — per-field merge (never shadows a lower layer)", () => {
  beforeEach(() => {
    __resetScopedDynamicCache();
    __resetKnownLimitsCache();
  });

  it("a provider entry that carries NO limits must not shadow the pattern's real limits", () => {
    // `muse-spark-*` provider entries set modalities only; the PATTERN entry
    // carries 1048576 / 131072. A short-circuit chain used to fall through to
    // the DEFAULT floor (200000 / 64000) for exactly this shape, which is the
    // same fabrication this resolver exists to prevent — one layer down.
    const limits = resolveKnownLimits("opencode", "muse-spark-1.2-contributor-free");
    const loose = getCapabilitiesForModel("opencode", "muse-spark-1.2-contributor-free");
    expect(limits.contextWindow).toBe(loose.contextWindow);
    expect(limits.maxOutput).toBe(loose.maxOutput);
    expect(limits.contextWindow).toBe(1048576);
    expect(limits.maxOutput).toBe(131072);
  });

  it("a dynamic row with contextWindow only must not hide the catalogue's maxOutput", () => {
    // syncedModelsRepo rows are partial by design; the strict resolver used to
    // drop max_tokens entirely in this case while the loose resolver kept it.
    registerDynamicCapabilitiesScoped("ollama", "gpt-4o", { contextWindow: 400000 });
    const limits = resolveKnownLimits("ollama", "gpt-4o");
    const loose = getCapabilitiesForModel("ollama", "gpt-4o");
    expect(limits.contextWindow).toBe(400000);
    expect(limits.maxOutput).toBe(loose.maxOutput);
    expect(limits.maxOutput).toBeGreaterThan(0);
  });

  it("a dynamic row overrides the catalogue's contextWindow (dynamic layers above)", () => {
    registerDynamicCapabilitiesScoped("ollama", "gpt-4o", { contextWindow: 400000 });
    expect(resolveKnownLimits("ollama", "gpt-4o").contextWindow).toBe(
      getCapabilitiesForModel("ollama", "gpt-4o").contextWindow,
    );
  });

  it("strict never disagrees with loose about a field loose took from a source", () => {
    // The invariant the doc comment claims. Exercises every source class:
    // provider override, dynamic, exact MODEL entry, and pattern.
    const cases = [
      ["opencode", "muse-spark-1.2-contributor-free"], // pattern only
      ["openai", "gpt-4o"],                            // exact
      ["nara", "gpt-4o"],                              // provider override
    ];
    for (const [provider, model] of cases) {
      const strict = resolveKnownLimits(provider, model);
      const loose = getCapabilitiesForModel(provider, model);
      const floorCw = loose.contextWindow === 200000; // DEFAULT floor
      const floorMo = loose.maxOutput === 64000;
      if (!floorCw) expect(strict.contextWindow).toBe(loose.contextWindow);
      if (!floorMo) expect(strict.maxOutput).toBe(loose.maxOutput);
    }
  });
});

describe("resolveKnownLimits — memo invalidation", () => {
  beforeEach(() => {
    __resetScopedDynamicCache();
    __resetKnownLimitsCache();
  });

  it("reflects a scoped dynamic write made AFTER the memo was populated", () => {
    // Prime the memo first, then change the underlying data. Without
    // invalidation this returns the stale first answer.
    const before = resolveKnownLimits("nara", "some-model");
    registerDynamicCapabilitiesScoped("nara", "some-model", { contextWindow: 400000, maxOutput: 32000 });
    const after = resolveKnownLimits("nara", "some-model");

    expect(after.contextWindow).toBe(400000);
    expect(after.maxOutput).toBe(32000);
    expect(after.contextWindow).not.toBe(before.contextWindow);
  });

  it("reflects a bare dynamic write made AFTER the memo was populated", () => {
    resolveKnownLimits(undefined, "bare-model-xyz"); // prime
    registerDynamicCapabilities("bare-model-xyz", { contextWindow: 999999 });
    expect(resolveKnownLimits(undefined, "bare-model-xyz").contextWindow).toBe(999999);
  });

  it("reflects repeated writes to the same key (not just the first)", () => {
    resolveKnownLimits("nara", "churn");
    registerDynamicCapabilitiesScoped("nara", "churn", { contextWindow: 111111 });
    expect(resolveKnownLimits("nara", "churn").contextWindow).toBe(111111);

    registerDynamicCapabilitiesScoped("nara", "churn", { contextWindow: 222222 });
    expect(resolveKnownLimits("nara", "churn").contextWindow).toBe(222222);
  });

  it("picks up a change to a -review variant of a memoized model", () => {
    // resolveKnownLimits strips a `-review` suffix, so a write under the base id
    // must also invalidate the variant's memo (or the variant keeps answering
    // with the value it computed before the write).
    resolveKnownLimits("nara", "claude-x-review");
    registerDynamicCapabilitiesScoped("nara", "claude-x", { contextWindow: 333333 });
    expect(resolveKnownLimits("nara", "claude-x-review").contextWindow).toBe(333333);
  });

  it("is cleared by the scoped-cache reset used in tests", () => {
    resolveKnownLimits("nara", "reset-me");
    registerDynamicCapabilitiesScoped("nara", "reset-me", { contextWindow: 444444 });
    __resetScopedDynamicCache();
    // Dynamic caps are gone, so the answer reverts to whatever the static
    // catalogue alone says — which is never the stale 444444.
    expect(resolveKnownLimits("nara", "reset-me").contextWindow).not.toBe(444444);
  });

  it("returns a frozen object so a caller cannot poison the memo", () => {
    const limits = resolveKnownLimits("openai", "gpt-4o");
    expect(Object.isFrozen(limits)).toBe(true);
    // Mutating a copy is fine; the memo must be unaffected.
    const copy = { ...limits, contextWindow: 1 };
    expect(copy.contextWindow).toBe(1);
    expect(resolveKnownLimits("openai", "gpt-4o").contextWindow).toBe(128000);
  });
});
