import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
const release = (version) => ({ ok: true, json: async () => ({ name: "@openai/codex", version }) });
const load = () => import("../../open-sse/services/codexDiscoveryVersion.js");

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Codex discovery release version", () => {
  it("refreshes each successful Sync so a later release needs no code edit", async () => {
    fetchMock.mockResolvedValueOnce(release("0.160.0")).mockResolvedValueOnce(release("0.200.0"));
    const { resolveCodexDiscoveryVersion } = await load();
    expect(await resolveCodexDiscoveryVersion()).toEqual({ version: "0.160.0" });
    expect(await resolveCodexDiscoveryVersion()).toEqual({ version: "0.200.0" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://registry.npmjs.org/@openai/codex/latest");
    expect(options.headers).toBeUndefined();
    expect(options.cache).toBe("no-store");
  });

  it("shares one release request across concurrent syncs", async () => {
    let finish;
    fetchMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { resolveCodexDiscoveryVersion } = await load();
    const first = resolveCodexDiscoveryVersion();
    const second = resolveCodexDiscoveryVersion();
    finish(release("0.160.0"));
    expect(await Promise.all([first, second])).toEqual([{ version: "0.160.0" }, { version: "0.160.0" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the last good version during an outage, backs off and recovers", async () => {
    fetchMock.mockResolvedValueOnce(release("0.160.0")).mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(release("0.200.0"));
    const { resolveCodexDiscoveryVersion } = await load();
    await resolveCodexDiscoveryVersion();
    const fallback = await resolveCodexDiscoveryVersion();
    expect(fallback.version).toBe("0.160.0");
    expect(fallback.warning).toContain("newly released models may be missing");
    expect(await resolveCodexDiscoveryVersion()).toEqual(fallback);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60000);
    expect(await resolveCodexDiscoveryVersion()).toEqual({ version: "0.200.0" });
  });

  it.each([
    { ok: false },
    { ok: true, json: async () => { throw new Error("bad JSON"); } },
    { ok: true, json: async () => ({ name: "wrong-package", version: "0.200.0" }) },
    release("0.200.0-beta.1"), release("not-a-version"), release("0.100.0"),
    { ok: true, json: async () => null },
  ])("uses the known baseline and warns on unusable release metadata %#", async (response) => {
    fetchMock.mockResolvedValue(response);
    const { resolveCodexDiscoveryVersion } = await load();
    const { CODEX_CLI_VERSION } = await import("../../open-sse/providers/shared.js");
    expect(await resolveCodexDiscoveryVersion()).toMatchObject({ version: CODEX_CLI_VERSION, warning: expect.any(String) });
  });

  it("does not downgrade a previously discovered release", async () => {
    fetchMock.mockResolvedValueOnce(release("0.200.0")).mockResolvedValueOnce(release("0.160.0"));
    const { resolveCodexDiscoveryVersion } = await load();
    await resolveCodexDiscoveryVersion();
    expect(await resolveCodexDiscoveryVersion()).toMatchObject({ version: "0.200.0", warning: expect.any(String) });
  });

  it("aborts a stalled metadata request and falls back instead of blocking Sync", async () => {
    fetchMock.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const { resolveCodexDiscoveryVersion } = await load();
    const result = resolveCodexDiscoveryVersion();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toMatchObject({ warning: expect.any(String) });
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
