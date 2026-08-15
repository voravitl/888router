import { describe, expect, it } from "vitest";

import {
  extractUpstreamErrorDetail,
  formatModelsFetchError,
  redactSecrets,
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

  it("collapses multi-line bodies onto one line", () => {
    expect(extractUpstreamErrorDetail("<html>\n  <body>502 Bad Gateway</body>\n</html>")).toBe(
      "<html> <body>502 Bad Gateway</body> </html>"
    );
  });

  it("never regresses below the old message when the body is empty", () => {
    for (const body of ["", "   ", null, undefined]) {
      expect(formatModelsFetchError(500, body)).toBe("Failed to fetch models: 500");
    }
  });

  it("caps the detail so a huge body cannot flood the UI", () => {
    const detail = extractUpstreamErrorDetail("x".repeat(5000));
    expect(detail.length).toBeLessThanOrEqual(300);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("does not throw on malformed or unexpected payloads", () => {
    for (const body of ["{ not json", "[]", "null", "42", JSON.stringify({ nested: { deep: {} } })]) {
      expect(() => formatModelsFetchError(400, body)).not.toThrow();
    }
  });
});

// A 401/403 body is exactly where an upstream is most likely to echo back the
// credential it just rejected, so redaction is not hypothetical here.
describe("secret redaction", () => {
  it("redacts vendor key formats", () => {
    for (const [secret, label] of [
      ["sk-abcdef1234567890abcdef", "openai-style"],
      ["xai-abcdef1234567890abcdef", "xai-style"],
      ["ghp_abcdef1234567890abcdef", "github-style"],
      ["AIzaSyAbcdef1234567890abcd", "google-style"],
    ]) {
      const out = redactSecrets(`rejected key ${secret} is invalid`);
      expect(out, label).not.toContain(secret);
      expect(out, label).toContain("[redacted]");
    }
  });

  it("redacts bearer/authorization values", () => {
    const out = redactSecrets("Authorization: Bearer someopaquetokenvalue rejected");
    expect(out).not.toContain("someopaquetokenvalue");
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

  it("leaves ordinary prose untouched", () => {
    const msg = "You have run out of credits or need a Grok subscription.";
    expect(redactSecrets(msg)).toBe(msg);
  });

  // Regression: an earlier revision matched the keyword with an OPTIONAL
  // separator and no length floor, so "access token could not be validated"
  // came out as "access token [redacted] not be validated" — the redactor
  // mangled the exact messages this module exists to surface.
  it("does not eat prose that merely contains a credential keyword", () => {
    for (const msg of [
      "OAuth2 access token could not be validated",
      "the token expired",
      "your api key is missing",
      "invalid bearer credentials supplied",
    ]) {
      expect(redactSecrets(msg)).toBe(msg);
    }
  });

  it("still redacts a bare keyword-value pair with no separator", () => {
    const out = redactSecrets("Bearer someopaquetokenvalue rejected");
    expect(out).not.toContain("someopaquetokenvalue");
    expect(out).toBe("Bearer [redacted] rejected");
  });
});
