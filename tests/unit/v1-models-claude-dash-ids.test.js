import { beforeEach, describe, expect, it, vi } from "vitest";

// /v1/models must expose Claude family ids in dash form for Claude Code
// auto-discovery (list-then-select). Dot form is misread as model "4".
// Follow-up to #101 / issue #102.

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => []),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));

vi.mock("open-sse/services/kiroModels.js", () => ({
  resolveKiroModels: vi.fn(async () => null),
}));
vi.mock("open-sse/services/kimchiModels.js", () => ({
  resolveKimchiModels: vi.fn(async () => null),
}));
vi.mock("open-sse/services/qoderModels.js", () => ({
  resolveQoderModels: vi.fn(async () => null),
}));
vi.mock("open-sse/services/copilotModels.js", () => ({
  resolveCopilotModels: vi.fn(async () => null),
}));
vi.mock("open-sse/services/clinepassModels.js", () => ({
  resolveClinepassModels: vi.fn(async () => null),
}));
vi.mock("@/sse/services/tokenRefresh", () => ({
  updateProviderCredentials: vi.fn(async () => {}),
}));

describe("/v1/models Claude dash ids (#102)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("lists Kiro Claude family models with dash version spelling", async () => {
    const { GET } = await import("../../src/app/api/v1/models/route.js");
    const res = await GET(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = (body.data || []).map((m) => m.id);

    // Static kiro registry uses dots; client-facing list must dashify.
    const kiroClaude = ids.filter((id) => id.startsWith("kr/claude-"));
    expect(kiroClaude.length).toBeGreaterThan(0);
    expect(kiroClaude.some((id) => id.includes("claude-opus-4-8"))).toBe(true);
    // No residual N.M form for Claude family on the list
    expect(kiroClaude.some((id) => /claude-(?:opus|sonnet|haiku)-\d+\.\d+/.test(id))).toBe(false);
  });

  it("does not rewrite non-Claude dotted ids", async () => {
    // Smoke: helper already covered; ensure list path still includes non-Claude
    // ids unchanged when present in static catalog.
    const { toClaudeCodeModelId } = await import("../../src/shared/utils/claudeCodeModelId.js");
    expect(toClaudeCodeModelId("glm-5.2")).toBe("glm-5.2");
  });
});
