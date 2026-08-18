import { describe, expect, it } from "vitest";
import {
  resolveComboContextWindow,
  resolveComboMaxOutput,
  applyComboContextFields,
} from "@/app/api/v1/models/route.js";
import { DEFAULT_CAPABILITIES } from "open-sse/providers/capabilities.js";

describe("Combo context window resolution", () => {
  it("resolves context window for combos with provider-prefixed models", () => {
    const combo = {
      name: "test-combo-1",
      models: ["kr/claude-sonnet-4.6", "openai/gpt-4o"],
    };
    // min(1000000, 128000) => 128000
    const cw = resolveComboContextWindow(combo);
    expect(cw).toBe(128000);
  });

  it("resolves context window for combos with bare model names (slashless)", () => {
    const combo = {
      name: "test-combo-2",
      models: ["claude-opus-4.7", "gpt-4o"],
    };
    // min(1000000, 128000) => 128000
    const cw = resolveComboContextWindow(combo);
    expect(cw).toBe(128000);
  });

  it("returns undefined for empty combo models", () => {
    expect(resolveComboContextWindow({ models: [] })).toBeUndefined();
  });

  it("returns undefined when all members are unknown (no fabricated floor)", () => {
    expect(
      resolveComboContextWindow({
        models: ["totally-unknown-model-xyz", "also-not-in-catalog-abc"],
      }),
    ).toBeUndefined();
  });

  it("ignores unknown members and mins known ones", () => {
    const cw = resolveComboContextWindow({
      models: ["unknown-model-xyz", "gpt-4o"],
    });
    expect(cw).toBe(128000);
  });

  it("resolveComboMaxOutput returns min known maxOutput, not a hardcoded 128k", () => {
    // gpt-4o maxOutput is catalog-known and smaller than Claude's 128k
    const mo = resolveComboMaxOutput({
      models: ["claude-opus-4.7", "gpt-4o"],
    });
    expect(mo).toBeDefined();
    expect(mo).toBeLessThanOrEqual(128000);
    expect(mo).toBe(16384); // gpt-4o pattern/exact maxOutput in catalog
  });

  it("applyComboContextFields omits fields when unresolved and for web combos", () => {
    const bare = applyComboContextFields({ id: "x" }, { models: ["unknown-only"] });
    expect(bare.context_length).toBeUndefined();
    expect(bare.max_tokens).toBeUndefined();

    const web = applyComboContextFields(
      { id: "search-combo" },
      { kind: "webSearch", models: ["gpt-4o"] },
    );
    expect(web.context_length).toBeUndefined();

    const llm = applyComboContextFields(
      { id: "good" },
      { models: ["gpt-4o"] },
    );
    expect(llm.context_length).toBe(128000);
    expect(llm.context_window).toBe(128000);
    expect(llm.contextWindow).toBe(128000);
    expect(llm.max_tokens).toBeDefined();
  });

  it("attaches capabilities with tools:true to LLM combos (not web/non-LLM combos)", () => {
    const llm = applyComboContextFields({ id: "good" }, { models: ["gpt-4o"] });
    expect(llm.capabilities).toBeDefined();
    expect(llm.capabilities.tools).toBe(true);
    expect(llm.capabilities.contextWindow).toBe(DEFAULT_CAPABILITIES.contextWindow);

    const web = applyComboContextFields(
      { id: "search-combo" },
      { kind: "webSearch", models: ["gpt-4o"] },
    );
    expect(web.capabilities).toBeUndefined();

    const nonLlm = applyComboContextFields(
      { id: "embed-combo" },
      { kind: "embedding", models: ["gpt-4o"] },
    );
    // non-LLM combos keep a uniform shape but advertise tools:false
    expect(nonLlm.capabilities).toBeDefined();
    expect(nonLlm.capabilities.tools).toBe(false);
  });

  it("preserves pre-existing capabilities on LLM combos", () => {
    const entry = { id: "good", capabilities: { tools: false, custom: 1 } };
    const out = applyComboContextFields(entry, { models: ["gpt-4o"] });
    expect(out.capabilities.tools).toBe(true); // default floor wins
    expect(out.capabilities.custom).toBe(1);   // pre-existing preserved
  });
});
