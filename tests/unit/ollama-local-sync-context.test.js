import { describe, it, expect } from "vitest";
import { getProviderCustomModelRows } from "@/shared/utils/providerCustomModels.js";

// Regression: synced Ollama models showed "1M" because the upstream context
// (details.context_length = 32768) was dropped at sync-add time, leaving the
// table to fall back to catalogue pattern guesses (*qwen*coder* → 1000000).
// The sync chain must now carry contextLength end-to-end:
// modal item → POST /api/models/custom → customModels row → tableModels row.

describe("ollama-local sync context carry-through", () => {
  it("keeps stored contextLength on the custom row", () => {
    const rows = getProviderCustomModelRows({
      customModels: [
        {
          providerAlias: "ollama-local",
          id: "qwen2.5-coder:14b-instruct-q8_0",
          type: "llm",
          source: "synced",
          contextLength: 32768,
        },
      ],
      modelAliases: {},
      providerAlias: "ollama-local",
      builtInModels: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].contextLength).toBe(32768);
  });

  it("omits contextLength when the stored row has none (fallback path intact)", () => {
    const rows = getProviderCustomModelRows({
      customModels: [
        { providerAlias: "ollama-local", id: "some-model", type: "llm" },
      ],
      modelAliases: {},
      providerAlias: "ollama-local",
      builtInModels: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].contextLength).toBeUndefined();
  });

  it("rejects non-numeric / non-positive stored values", () => {
    const rows = getProviderCustomModelRows({
      customModels: [
        { providerAlias: "ollama-local", id: "a", type: "llm", contextLength: "nope" },
        { providerAlias: "ollama-local", id: "b", type: "llm", contextLength: 0 },
        { providerAlias: "ollama-local", id: "c", type: "llm", contextLength: -5 },
      ],
      modelAliases: {},
      providerAlias: "ollama-local",
      builtInModels: [],
    });
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.contextLength).toBeUndefined();
  });
});
