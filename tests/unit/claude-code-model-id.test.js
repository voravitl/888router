import { describe, expect, it } from "vitest";

import { getClaudeCodeModelId, getClaudeCodeFullModelId } from "../../src/shared/utils/claudeCodeModelId.js";

// The copy-to-clipboard value must include the "[1m]" suffix IFF the model's
// resolved context window is ≥ 1M — so users copying from the Web Dashboard
// get a Claude-Code-ready value without needing to know about the suffix.
describe("getClaudeCodeModelId", () => {
  it("appends [1m] to a 1M-context model", () => {
    expect(getClaudeCodeModelId("glm", "glm-5.2")).toBe("glm-5.2[1m]");
  });

  it("appends [1m] to a dash/date-suffixed 1M variant", () => {
    expect(getClaudeCodeModelId("bpm", "glm-5-2-260617")).toBe("glm-5-2-260617[1m]");
  });

  it("leaves a 200k model bare (no suffix)", () => {
    expect(getClaudeCodeModelId("glm", "glm-5.1")).toBe("glm-5.1");
    expect(getClaudeCodeModelId("glm", "glm-5")).toBe("glm-5");
    expect(getClaudeCodeModelId("glm", "glm-4.7")).toBe("glm-4.7");
  });

  it("handles unknown models (no caps → bare id)", () => {
    expect(getClaudeCodeModelId("glm", "made-up-model")).toBe("made-up-model");
  });

  it("handles non-string / empty input without throwing", () => {
    expect(getClaudeCodeModelId("glm", "")).toBe("");
    expect(getClaudeCodeModelId("glm", undefined)).toBe("");
    expect(getClaudeCodeModelId("glm", null)).toBe("");
  });
});

describe("getClaudeCodeFullModelId", () => {
  it("returns alias/model[1m] for 1M models", () => {
    expect(getClaudeCodeFullModelId("glm", "glm-5.2")).toBe("glm/glm-5.2[1m]");
    expect(getClaudeCodeFullModelId("bpm", "glm-5-2-260617")).toBe("bpm/glm-5-2-260617[1m]");
  });

  it("returns bare alias/model for sub-1M models", () => {
    expect(getClaudeCodeFullModelId("glm", "glm-5.1")).toBe("glm/glm-5.1");
  });
});
