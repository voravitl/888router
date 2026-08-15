import { describe, expect, it } from "vitest";

import {
  extractUpstreamErrorDetail,
  formatModelsFetchError,
  redactSecrets,
  safeLogDetail,
} from "../../src/lib/upstreamErrorDetail.js";

// Model-sync failures surfaced as a bare `Failed to fetch models: 403`, which
// makes a billing 403 indistinguishable from an auth 403 in the dashboard — the
// distinguishing text was logged server-side and then dropped (#279).
describe("upstream error detail extraction (#279)", () => {
  it("surfaces the xAI billing reason that motivated this fix", () => {
    const body = JSON.stringify({
      code: "personal-team-blocked:spending-limit",
      error: "You have run out of credits or need a Grok subscription.",
    });
    expect(formatModelsFetchError(403, body)).toBe(
      "Failed to fetch models: 403 — You have run out of credits or need a Grok subscription."
    );
  });

  it("distinguishes an auth 403 from a billing 403", () => {
    const auth = formatModelsFetchError(403, JSON.stringify({ error: { message: "Invalid API key" } }));
    const billing = formatModelsFetchError(403, JSON.stringify({ error: "Out of credits" }));
    expect(auth).not.toBe(billing);
    expect(auth).toContain("Invalid API key");
    expect(billing).toContain("Out of credits");
  });

  it("reads the nested OpenAI-style { error: { message } } shape", () => {
    const body = JSON.stringify({ error: { message: "model not found", type: "invalid_request_error" } });
    expect(extractUpstreamErrorDetail(body)).toBe("model not found");
  });

  it("falls back to the raw text for non-JSON bodies", () => {
    expect(extractUpstreamErrorDetail("upstream connect error or disconnect")).toBe(
      "upstream connect error or disconnect"
    );
  });

  it("reduces an HTML error page to its text", () => {
    const detail = extractUpstreamErrorDetail("<html>\n  <body><h1>502 Bad Gateway</h1></body>\n</html>");
    expect(detail).toContain("502 Bad Gateway");
    expect(detail).not.toContain("<");
  });

  it("drops script/style content from an HTML page", () => {
    const detail = extractUpstreamErrorDetail("<html><script>var k='secret'</script><body>503</body></html>");
    expect(detail).not.toContain("secret");
    expect(detail).toContain("503");
  });

  it("never regresses below the old message when the body is empty", () => {
    for (const body of ["", "   ", null, undefined]) {
      expect(formatModelsFetchError(500, body)).toBe("Failed to fetch models: 500");
    }
  });

  it("caps the detail so a huge body cannot flood the UI", () => {
    const detail = extractUpstreamErrorDetail("x".repeat(50000));
    expect(detail.length).toBeLessThanOrEqual(300);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("does not throw on malformed or unexpected payloads", () => {
    for (const body of ["{ not json", "[]", "null", "42", JSON.stringify({ nested: { deep: {} } })]) {
      expect(() => formatModelsFetchError(400, body)).not.toThrow();
    }
  });

  // A parsed payload with no allowlisted message field must yield NOTHING.
  // Falling back to the raw body would defeat the allowlist and leak internal
  // hostnames, request echoes, or credentials sitting in unrecognised fields.
  it("emits nothing for a payload carrying no recognised message field", () => {
    const body = JSON.stringify({ debug: { host: "internal-db.internal", request: { path: "/x" } } });
    expect(extractUpstreamErrorDetail(body)).toBe("");
    expect(formatModelsFetchError(500, body)).toBe("Failed to fetch models: 500");
  });

  it("does not emit a credential parked in a non-message field", () => {
    const body = JSON.stringify({
      error: { message: "bad" },
      access_token: "QwErTyUiOpAsDfGhJkLzXcVbNm123456",
    });
    const out = formatModelsFetchError(403, body);
    expect(out).not.toContain("QwErTyUiOpAsDfGhJkLzXcVbNm123456");
    expect(out).toBe("Failed to fetch models: 403 — bad");
  });
});

// A 401/403 body is exactly where an upstream is most likely to echo back the
// credential it just rejected, so redaction is not hypothetical here. It is
// defence in depth — the field allowlist above is the actual boundary.
describe("secret redaction", () => {
  it("redacts vendor key formats", () => {
    for (const [secret, label] of [
      ["sk-abcdef1234567890abcdef", "openai"],
      ["xai-abcdef1234567890abcdef", "xai"],
      ["ghp_abcdef1234567890abcdef", "github-pat"],
      ["github_pat_abcdef1234567890abcdef", "github-fine-grained"],
      ["glpat-abcdef1234567890abcdef", "gitlab"],
      ["AIzaSyAbcdef1234567890abcdefghij", "google"],
      ["xoxb-1234567890-abcdefghij", "slack"],
      ["AKIAIOSFODNN7EXAMPLE", "aws"],
    ]) {
      const out = redactSecrets(`rejected key ${secret} is invalid`);
      expect(out, label).not.toContain(secret);
      expect(out, label).toContain("[redacted]");
    }
  });

  it("redacts every HTTP auth scheme's value, keeping the scheme name", () => {
    for (const scheme of ["Basic", "Bearer", "Digest", "Negotiate", "Token"]) {
      const out = redactSecrets(`Authorization: ${scheme} dXNlcjpwYXNzd29yZA==`);
      expect(out, scheme).not.toContain("dXNlcjpwYXNzd29yZA");
    }
  });

  it("redacts quoted JSON fields whose name looks credential-bearing", () => {
    for (const field of [
      "access_token",
      "refresh_token",
      "client_secret",
      "api_key",
      "apiKey",
      "password",
      "session_id",
      "signature",
    ]) {
      const out = redactSecrets(`{"${field}": "opaque-secret-value"}`);
      expect(out, field).not.toContain("opaque-secret-value");
    }
  });

  it("redacts JWTs and long hex runs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";
    expect(redactSecrets(`token ${jwt} expired`)).not.toContain("dBjftJeZ4CVPmB92K27uhbUJU1p1r");
    const hex = "a".repeat(40);
    expect(redactSecrets(`machineId ${hex}`)).not.toContain(hex);
  });

  it("redacts through the public formatter, not just the helper", () => {
    const body = JSON.stringify({ error: { message: "invalid key sk-abcdef1234567890abcdef" } });
    const out = formatModelsFetchError(401, body);
    expect(out).not.toContain("sk-abcdef1234567890abcdef");
    expect(out).toContain("[redacted]");
  });

  // Regression set. Every entry here was a real over-redaction found in review:
  // vendor prefixes without their delimiter matched ordinary words, and matching
  // a keyword with an OPTIONAL separator mangled the exact messages this module
  // exists to surface.
  it("leaves ordinary prose untouched", () => {
    for (const msg of [
      "You have run out of credits or need a Grok subscription.",
      "skyscraper too tall",
      "ghostwriter needed",
      "the token expired",
      "OAuth2 access token could not be validated",
      "invalid bearer credentials supplied",
      "your api key is missing",
      "skipped 3 models",
    ]) {
      expect(redactSecrets(msg), msg).toBe(msg);
    }
  });

  // "token: expired" must NOT become "token [redacted]" — that destroys the
  // diagnostic the user needs, which is the whole point of #279.
  it("keeps a benign state word after a credential keyword", () => {
    for (const msg of [
      "token: expired",
      "token=invalid",
      "API key: missing",
      "access_token: revoked",
      "authorization: required",
    ]) {
      expect(redactSecrets(msg), msg).toBe(msg);
    }
  });

  it("still redacts a real value after a credential keyword", () => {
    const out = redactSecrets("token=QwErTyUiOpAsDfGhJkLzXcVbNm123456");
    expect(out).not.toContain("QwErTyUiOpAsDfGhJkLzXcVbNm123456");
  });

  // Review round 2: the scheme match was case-sensitive, and the keyword match
  // required a `:`/`=` separator, so these all passed through unredacted.
  it("redacts a lowercase scheme and a whitespace-separated value", () => {
    for (const input of [
      "bearer abcdefghijklmnopqr",
      "API key abcdefghijklmnopqr",
      "cookie: sessionvalue12345678",
      "Password: hunter2xyzabcdef",
      "client secret abcdefghijklmnopqr",
    ]) {
      expect(redactSecrets(input), input).toContain("[redacted]");
      expect(redactSecrets(input), input).toBe(
        `${input.split(/\s*[:=]\s*|\s+(?=[A-Za-z0-9+/=._~-]{16,}$)/)[0]} [redacted]`
      );
    }
  });

  // A whitespace separator is ambiguous — English prose puts ordinary words
  // after these nouns. The >=16-char floor is what keeps prose intact; an
  // earlier revision without it produced "access token [redacted] not be
  // validated".
  it("keeps prose after a keyword when the next word is not credential-shaped", () => {
    for (const msg of [
      "OAuth2 access token could not be validated",
      "access token could not be validated",
      "password reset required",
      "credential check failed",
    ]) {
      expect(redactSecrets(msg), msg).toBe(msg);
    }
  });
});

// Review round 2 found three ways to bypass the field allowlist. Each is pinned
// here because each one re-opens the boundary if it regresses.
describe("allowlist cannot be bypassed", () => {
  it("withholds a bare top-level JSON string", () => {
    // No field to allowlist, so emitting it would bypass the boundary entirely.
    expect(extractUpstreamErrorDetail('"hunter2"')).toBe("");
    expect(formatModelsFetchError(403, '"hunter2"')).toBe("Failed to fetch models: 403");
  });

  it("withholds bare top-level JSON scalars", () => {
    for (const body of ["42", "true", "null", "[]", '["hunter2"]']) {
      expect(extractUpstreamErrorDetail(body), body).toBe("");
    }
  });

  it("withholds a JSON-shaped body that fails to parse", () => {
    // Previously this fell through to the plain-text path, emitting the unknown
    // fields the allowlist exists to suppress.
    const truncated = '{"message":"ok","leaked_secret":"hunter2';
    expect(extractUpstreamErrorDetail(truncated)).toBe("");
    expect(extractUpstreamErrorDetail(truncated)).not.toContain("hunter2");
  });

  it("parses a large valid JSON body whole instead of slicing it into garbage", () => {
    // Slicing before parsing made a valid body malformed, which diverted it to
    // the raw-text path and leaked the very field being guarded.
    const body = JSON.stringify({ leaked_secret: "S".repeat(9000), message: "ok" });
    expect(extractUpstreamErrorDetail(body)).toBe("ok");
    expect(extractUpstreamErrorDetail(body)).not.toContain("SSSS");
  });

  it("withholds a JSON body above the parse cap rather than degrading it", () => {
    const body = JSON.stringify({ message: "ok", filler: "F".repeat(300000) });
    expect(extractUpstreamErrorDetail(body)).toBe("");
    expect(extractUpstreamErrorDetail(body)).not.toContain("FFFF");
  });

  it("still reads plain-text and HTML bodies, which have no fields to protect", () => {
    expect(extractUpstreamErrorDetail("upstream connect error or disconnect")).toBe(
      "upstream connect error or disconnect"
    );
    expect(extractUpstreamErrorDetail("<html><body>502 Bad Gateway</body></html>")).toContain("502");
  });
});

// An ANSI escape can clear a terminal or hide adjacent log lines; bidi overrides
// can visually reorder text. Neither belongs in something we log or render.
describe("control character stripping", () => {
  const ESC = String.fromCharCode(27);

  it("strips ANSI escapes from the emitted detail", () => {
    const detail = extractUpstreamErrorDetail(JSON.stringify({ message: `${ESC}[2Jcleared` }));
    expect(detail).not.toContain(ESC);
    expect(detail).toBe("[2Jcleared");
  });

  it("strips bidi overrides", () => {
    const rlo = String.fromCodePoint(0x202e);
    const detail = extractUpstreamErrorDetail(JSON.stringify({ message: `safe${rlo}reversed` }));
    expect(detail).not.toContain(rlo);
  });

  it("strips control characters from the log form too", () => {
    expect(safeLogDetail(JSON.stringify({ message: `${ESC}[31mred` }))).not.toContain(ESC);
  });
});

// The raw body was previously logged verbatim, which persists any credential the
// upstream echoed back — inconsistent with this module's own premise.
describe("safeLogDetail", () => {
  it("logs the sanitized detail, not the raw body", () => {
    const body = JSON.stringify({ error: { message: "invalid key sk-abcdef1234567890abcdef" } });
    const out = safeLogDetail(body);
    expect(out).not.toContain("sk-abcdef1234567890abcdef");
    expect(out).toContain("[redacted]");
  });

  it("withholds an unrecognised body instead of dumping it", () => {
    const body = JSON.stringify({ internal: { host: "db.internal", token: "shouldnotappear1234567" } });
    const out = safeLogDetail(body);
    expect(out).not.toContain("shouldnotappear1234567");
    expect(out).not.toContain("db.internal");
    expect(out).toContain("withheld");
  });

  it("reports a byte count for a withheld body", () => {
    expect(safeLogDetail(JSON.stringify({ unknown: 1 }))).toMatch(/\d+ bytes withheld/);
  });
});
