// P0 GOLDEN: lock buildUrl + buildHeaders cho mọi provider trên code CŨ.
// Sinh snapshot lần đầu (baseline) → sau refactor chạy lại phải khớp y hệt.
// Mock proxyFetch + uuid-heavy executors KHÔNG cần ở đây vì chỉ gọi buildUrl/buildHeaders (pure).
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { sanitize, HOST_DEPENDENT_HEADERS } from "./golden-url-header.sanitize.mjs";

// Credentials mẫu cố định (deterministic) — KHÔNG dùng Date.now/random.
const API_KEY_CRED = { apiKey: "sk-test-APIKEY", providerSpecificData: {} };
const OAUTH_CRED = { accessToken: "tok-test-ACCESS", providerSpecificData: {} };
const SPECIAL_CRED = {
  apiKey: "sk-test-APIKEY",
  accessToken: "tok-test-ACCESS",
  providerSpecificData: { accountId: "ACC123", region: "sgp", baseUrl: "https://custom.example.com/v1", orgId: "ORG9" },
};

// Provider cần executor riêng (buildUrl/buildHeaders không nằm ở DefaultExecutor) → bỏ qua ở golden này.
// Chúng được lock riêng ở 11-provider edge tests / unit test chuyên biệt.
const SPECIALIZED = new Set([
  "antigravity", "azure", "gemini-cli", "github", "iflow", "qoder", "kiro",
  "codex", "cursor", "vertex", "vertex-partner", "qwen", "opencode",
  "opencode-go", "grok-web", "perplexity-web", "chatgpt-web", "zenmux-free", "ollama-local", "commandcode",
  "xiaomi-tokenplan", "mimo-free",
  "aipass", "aipass-th", "aipass-bridge", "ap",
]);

// Sanitize header: khử token + field thời gian động (kimi X-Msh-Device-Id) để snapshot ổn định.
//
// The sanitizer and the list of machine-dependent headers it normalizes live
// in golden-url-header.sanitize.mjs, because the host-probe helper used by
// the guard below must use the SAME implementation — otherwise the guard
// would compare two different normalizations and prove nothing.
// See that file for the list, the reason it exists, and the history (the
// snapshot was pinned to the maintainer's macOS box and failed on the Linux
// CI runner).
const providerIds = Object.keys(PROVIDERS).filter((p) => !SPECIALIZED.has(p)).sort();

describe("GOLDEN buildUrl (default executor providers)", () => {
  for (const pid of providerIds) {
    it(`${pid} → url (stream + non-stream)`, () => {
      const ex = new DefaultExecutor(pid);
      const cred = PROVIDERS[pid].noAuth ? {} : SPECIAL_CRED;
      const model = "test-model";
      const snap = {
        stream: safe(() => ex.buildUrl(model, true, 0, cred)),
        nonStream: safe(() => ex.buildUrl(model, false, 0, cred)),
      };
      expect(snap).toMatchSnapshot();
    });
  }
});

describe("GOLDEN buildHeaders (default executor providers)", () => {
  for (const pid of providerIds) {
    it(`${pid} → headers (apiKey / oauth)`, () => {
      const ex = new DefaultExecutor(pid);
      const snap = {
        apiKey: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, true))),
        oauth: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : OAUTH_CRED, true))),
        nonStream: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, false))),
      };
      expect(snap).toMatchSnapshot();
    });
  }
});

// Structural guard: the golden snapshot must be MACHINE-INDEPENDENT.
//
// The snapshot records what the gateway sends upstream. If a header carries
// the host's platform, arch, node version or hostname, the recorded value
// describes the machine that happened to run the suite, not the gateway's
// behaviour — and the snapshot then fails on every other machine.
//
// This was not hypothetical. The suite was green on macOS and red on the
// Linux CI runner for 4 cline-family providers (X-PLATFORM /
// X-PLATFORM-VERSION), then red again for kimi / kimi-coding
// (X-Msh-Device-Model), then red again for the same two providers
// (X-Msh-Device-Name = hostname()). None of those failures were visible
// on the maintainer's machine.
//
// How the guard works: it runs the same header dump TWICE in two separate
// processes —
//   1. the host as-is, and
//   2. with every source of host identity replaced by a canary
//      (golden-url-header.host-canary.cjs, loaded with --require so it
//      patches os.* BEFORE the application modules are imported).
// Any header whose value CHANGES between the two runs is host-derived: its
// value comes from the machine, not from the gateway's logic. Those headers
// must be in HOST_DEPENDENT_HEADERS.
//
// A perturbation comparison is used rather than matching a value against a
// list of "looks like a platform" strings, because that produced a false
// positive: `claude` sends "X-Stainless-Arch: arm64" as a HARDCODED spoof
// constant (open-sse/providers/registry/claude.js) which happens to equal
// the maintainer's real arch. A value-based rule flags it; the perturbation
// correctly does not, because perturbing the arch does not change it.
describe("GOLDEN snapshot must not encode the machine that produced it", () => {
  const PROBE = fileURLToPath(new URL("./golden-url-header.host-probe.mjs", import.meta.url));
  const CANARY = fileURLToPath(new URL("./golden-url-header.host-canary.cjs", import.meta.url));
  const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

  function runProbe(withCanary) {
    const args = withCanary
      ? ["--require", CANARY, PROBE]
      : [PROBE];
    // spawnSync BLOCKS the event loop, so a hung child cannot be interrupted
    // by vitest's test timeout — it would stall the whole CI job until the
    // 30-minute workflow timeout with no useful error. Bound it here.
    const res = spawnSync(process.execPath, args, {
      encoding: "utf8",
      cwd: REPO_ROOT,
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    if (res.error) {
      throw new Error(`host probe failed to run (canary=${withCanary}): ${res.error.message}`);
    }
    if (res.status !== 0) {
      throw new Error(`host probe failed (canary=${withCanary}): ${res.stderr || res.stdout}`);
    }
    return JSON.parse(res.stdout);
  }

  it("the sanitized headers are identical under two different host identities", () => {
    const before = runProbe(false);
    const after = runProbe(true);

    // Sanity: the canary run must really have run under a different machine
    // identity, otherwise the comparison below proves nothing.
    expect(after.host.platform).not.toBe(before.host.platform);
    expect(after.host.arch).not.toBe(before.host.arch);
    expect(after.host.hostname).not.toBe(before.host.hostname);
    expect(after.host.version).not.toBe(before.host.version);

    // The probe sanitizes with the SAME function the snapshot uses, so this
    // is the exact property the snapshot relies on: the recorded header set
    // must not depend on the machine. If a value still differs between the
    // two runs, it leaks the host into the snapshot, and the snapshot will
    // fail on every other machine.
    const differing = [];
    for (const [key, value] of Object.entries(before.headers)) {
      const other = after.headers[key];
      if (other === undefined) continue;
      if (other !== value) {
        differing.push(`${key}: ${JSON.stringify(value)} → ${JSON.stringify(other)}`);
      }
    }

    expect(
      differing,
      "These header values still differ after sanitize(), so they describe the MACHINE, not the gateway. "
      + "The golden snapshot would differ on every other machine. "
      + "Add the header to HOST_DEPENDENT_HEADERS in golden-url-header.sanitize.mjs and refresh the snapshot with -u.",
    ).toEqual([]);
  });

  it("the host-dependent header list has no dead entries", () => {
    // The list must not accumulate dead entries: a header that no provider
    // sends any more would mean someone renamed it and the guard above
    // went blind for that header.
    const present = new Set(Object.keys(runProbe(false).headers).map((k) => k.split(" ").pop()));
    const unused = [...HOST_DEPENDENT_HEADERS].filter((h) => !present.has(h));
    expect(unused, "HOST_DEPENDENT_HEADERS lists a header no provider sends").toEqual([]);
  });
});

function safe(fn) {
  try { return fn(); } catch (e) { return `THROW: ${e.message}`; }
}
