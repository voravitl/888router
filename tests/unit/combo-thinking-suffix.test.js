import { describe, it, expect } from "vitest";

// A thinking-level suffix on a COMBO name ("9-free(low)") addresses the
// combo, not one of its members. The combo is registered under its bare
// name, so the lookup has to use the base id and the suffix has to be handed
// to every member.
//
// Before this, "9-free(minimal)" missed the combo entirely and fell through
// to the normal model path, where the client got:
//   "No active credentials for provider: openai"
// — an error about credentials for a provider nobody asked for.
import { splitThinkingSuffix } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { applyThinkingSuffixToMembers } from "../../src/sse/services/model.js";

describe("splitting a thinking suffix off a model id", () => {
  it("splits base and suffix", () => {
    expect(splitThinkingSuffix("9-free(low)")).toEqual({ base: "9-free", suffix: "(low)" });
    expect(splitThinkingSuffix("ag/gemini-3.8-flash-high(none)")).toEqual({
      base: "ag/gemini-3.8-flash-high",
      suffix: "(none)",
    });
  });

  it("leaves a bare model id alone", () => {
    expect(splitThinkingSuffix("9-free")).toEqual({ base: "9-free", suffix: "" });
    expect(splitThinkingSuffix("ag/gemini-3.8-flash-high")).toEqual({
      base: "ag/gemini-3.8-flash-high",
      suffix: "",
    });
  });

  it("handles a suffix that is not a level (budget, auto)", () => {
    expect(splitThinkingSuffix("claude-opus-4-8(8192)")).toEqual({
      base: "claude-opus-4-8",
      suffix: "(8192)",
    });
    expect(splitThinkingSuffix("9-free(auto)")).toEqual({ base: "9-free", suffix: "(auto)" });
  });

  it("does not throw on a non-string", () => {
    expect(splitThinkingSuffix(undefined)).toEqual({ base: undefined, suffix: "" });
    expect(splitThinkingSuffix(null)).toEqual({ base: null, suffix: "" });
  });
});

describe("applying a combo's thinking suffix to its members", () => {
  it("gives every member the suffix", () => {
    expect(
      applyThinkingSuffixToMembers(
        ["ollama/minimax-m3.1-flash", "oc/beam-free", "nous/meituan/longcat-2.5-preview:free"],
        "(low)",
      ),
    ).toEqual([
      "ollama/minimax-m3.1-flash(low)",
      "oc/beam-free(low)",
      "nous/meituan/longcat-2.5-preview:free(low)",
    ]);
  });

  it("replaces a suffix a member already carries instead of stacking", () => {
    expect(applyThinkingSuffixToMembers(["cc/claude-opus-4-8(high)"], "(low)")).toEqual([
      "cc/claude-opus-4-8(low)",
    ]);
  });

  it("returns the members untouched when there is no suffix", () => {
    const members = ["oc/beam-free"];
    expect(applyThinkingSuffixToMembers(members, "")).toEqual(members);
  });
});
