// Shared header sanitizer for the golden URL/header snapshot.
//
// Lives in its own module because TWO files need the SAME implementation:
//   - golden-url-header.test.js  — snapshots the sanitized headers
//   - golden-url-header.host-probe.mjs — dumps the sanitized headers for
//     the host-identity comparison
// If they diverged, the comparison would compare two different
// normalizations and prove nothing.
//
// MACHINE-DEPENDENT VALUES MUST BE NORMALIZED. These headers carry the host
// platform, arch, node version and hostname:
//   X-PLATFORM         (process.platform)   — cline / clinepass / kimi / kimi-coding
//   X-PLATFORM-VERSION (process.version)     — same providers
//   X-Msh-Device-Model (`${process.platform} ${process.arch}`) — kimi / kimi-coding
//   X-Msh-Device-Name  (hostname())          — kimi / kimi-coding
// A snapshot that records them pins the test to ONE machine: it passed on the
// maintainer's macOS box and failed on the Linux CI runner, because the
// snapshot said "darwin" and the runner produced "linux" (and the runner's
// hostname where the snapshot had the maintainer's).
//
// The header VALUE is not what the suite is testing — the URL, the auth shape
// and the provider-specific headers are. So the host is replaced with a
// placeholder and the assertion about the header's PRESENCE is kept.
//
// The list is not complete by construction: a new provider can start
// emitting a new host-derived header. That is what the host-probe guard in
// golden-url-header.test.js is for — it compares a real host run against a
// canary run and fails, naming the provider and the header, when a NEW
// host-derived value appears. So the list cannot silently go stale.

export const HOST_DEPENDENT_HEADERS = new Set([
  "X-PLATFORM",
  "X-PLATFORM-VERSION",
  "X-Msh-Device-Model",
  "X-Msh-Device-Name",
]);

export function sanitize(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOST_DEPENDENT_HEADERS.has(k)) {
      out[k] = "<HOST>";
      continue;
    }
    out[k] = typeof v === "string"
      ? v.replace(/Bearer .+/, "Bearer <TOK>")
          .replace(/sk-test-APIKEY|tok-test-ACCESS/g, "<CRED>")
          .replace(/kimi-\d{10,}/g, "kimi-<TS>")
      : v;
  }
  return out;
}
