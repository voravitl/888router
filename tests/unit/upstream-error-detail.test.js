import { describe, expect, it } from "vitest";

import {
  UPSTREAM_ERROR_REASONS,
  classifyUpstreamError,
  explainUpstreamError,
  formatModelsFetchError,
  safeLogDetail,
} from "../../src/lib/upstreamErrorDetail.js";

const FIXED_STRINGS = Object.values(UPSTREAM_ERROR_REASONS);

/** Every string this module is allowed to emit is one of ours. */
function isOurOwnText(out, status) {
  return out === `Failed to fetch models: ${status}` || FIXED_STRINGS.some((r) => out.endsWith(r));
}

// The point of #279: a billing 403 and an auth 403 were the same string in the
// dashboard, which is what made #272 hard to diagnose — no token refresh clears a
// billing 403, but nothing said so.
describe("upstream error classification (#279)", () => {
  it("distinguishes the xAI billing 403 from an auth 403", () => {
    const billing = formatModelsFetchError(
      403,
      JSON.stringify({
        code: "personal-team-blocked:spending-limit",
        error: "You have run out of credits or need a Grok subscription.",
      })
    );
    const auth = formatModelsFetchError(403, JSON.stringify({ error: { message: "Invalid API key provided" } }));

    expect(billing).not.toBe(auth);
    expect(billing).toContain("billing, not auth");
    expect(auth).toContain("re-authenticate");
  });

  it("classifies the reason classes it claims to", () => {
    const cases = [
      [402, "payment required", "billing"],
      [429, "rate limit exceeded", "quota"],
      [401, "token has expired", "auth_expired"],
      [401, "invalid_grant", "auth_invalid"],
      [401, "api key is required", "auth_missing"],
      [403, "insufficient scope", "permission"],
      [404, "no such endpoint", "not_found"],
      [405, "method not allowed", "unsupported"],
      [504, "deadline exceeded", "timeout"],
      [503, "temporarily unavailable", "unavailable"],
      [403, "blocked in your region", "blocked"],
      [500, "ECONNREFUSED", "network"],
      [500, "internal server error", "server"],
    ];
    for (const [status, body, expected] of cases) {
      expect(classifyUpstreamError(status, body), `${status} ${body}`).toBe(expected);
    }
  });

  it("puts billing ahead of auth when a body mentions both", () => {
    // A billing failure often arrives worded like an auth failure. Getting this
    // order wrong is the original #272 misdiagnosis.
    expect(classifyUpstreamError(403, "unauthorized: you have run out of credits")).toBe("billing");
  });

  it("falls back to the status when the body says nothing recognisable", () => {
    for (const [status, expected] of [
      [401, "auth_invalid"],
      [402, "billing"],
      [403, "permission"],
      [429, "quota"],
      [599, "server"],
    ]) {
      expect(classifyUpstreamError(status, ""), String(status)).toBe(expected);
    }
  });

  it("prefers a body signal over the status code", () => {
    // A one-word body still carries a signal, and it wins: "Forbidden" on a 401
    // describes a permission problem more precisely than the status alone.
    expect(classifyUpstreamError(401, "Forbidden")).toBe("permission");
    expect(classifyUpstreamError(500, "rate limit exceeded")).toBe("quota");
  });

  it("never regresses below the pre-#279 message when nothing is known", () => {
    for (const body of ["", "   ", null, undefined]) {
      expect(formatModelsFetchError(418, body)).toBe("Failed to fetch models: 418");
    }
    expect(classifyUpstreamError(418, "teapot")).toBeNull();
    expect(explainUpstreamError(418, "")).toBe("");
  });

  it("does not throw on any body shape", () => {
    for (const body of ["{ not json", "[]", "null", "42", '"str"', "<html>x</html>", null, undefined, 7]) {
      expect(() => formatModelsFetchError(500, body)).not.toThrow();
    }
  });
});

// THE core invariant. Three review rounds of a redaction-based design each lost
// to a new evasion, so the design changed: the body is matched against, never
// emitted. Each entry below is a secret that leaked in some earlier revision.
describe("no upstream bytes are ever emitted", () => {
  const SECRETS = [
    "hunter2",
    "correct horse battery staple",
    "verysecretvalue123",
    "abcdefghijklmnop",
    "sk-abcdef1234567890abcdef",
    "dXNlcjpwYXNzd29yZA",
    "QwErTyUiOpAsDfGhJkLzXcVbNm123456",
    "db.internal",
    "shouldnotappear1234",
  ];
  const NUL = String.fromCharCode(0);
  const ESC = String.fromCharCode(27);
  const ZWSP = String.fromCodePoint(0x200b);

  const BODIES = [
    ["bare top-level JSON string", 403, '"hunter2"'],
    ["NUL-prefixed JSON", 403, `${NUL}${JSON.stringify({ message: "safe", rejected_value: "hunter2" })}`],
    ["control char inside keyword", 401, JSON.stringify({ message: `Bear${ESC}er abcdefghijklmnop` })],
    ["zero-width space inside keyword", 401, `Bear${ZWSP}er abcdefghijklmnop`],
    ["multi-word quoted password", 401, 'password: "correct horse battery staple"'],
    ["multiple cookie pairs", 401, "cookie: sid=abc; auth=verysecretvalue123"],
    ["basic auth value", 401, "Authorization: Basic dXNlcjpwYXNzd29yZA=="],
    ["credential in non-message field", 403, JSON.stringify({ access_token: "QwErTyUiOpAsDfGhJkLzXcVbNm123456", error: { message: "bad" } })],
    ["internal metadata", 500, JSON.stringify({ internal: { host: "db.internal", token: "shouldnotappear1234" } })],
    ["truncated JSON", 500, '{"message":"ok","leaked":"hunter2'],
    ["secret inside the message field", 401, JSON.stringify({ error: { message: "invalid key sk-abcdef1234567890abcdef" } })],
    ["oversized body", 500, JSON.stringify({ message: "ok", filler: "hunter2".repeat(50000) })],
  ];

  for (const [label, status, body] of BODIES) {
    it(`emits none of the body: ${label}`, () => {
      const out = formatModelsFetchError(status, body);
      for (const secret of SECRETS) {
        expect(out, `${label} leaked ${secret}`).not.toContain(secret);
      }
      expect(isOurOwnText(out, status), `${label} produced off-table text: ${out}`).toBe(true);
    });
  }

  it("only ever returns strings from the fixed table", () => {
    // Fuzz: no input may produce text outside the table.
    const fragments = ["error", "token", "credits", "{", '"', "\\", NUL, ESC, ZWSP, "<html>", "%s", "‮"];
    for (let i = 0; i < 400; i++) {
      let body = "";
      const parts = 1 + (i % 5);
      for (let p = 0; p < parts; p++) body += fragments[(i * 7 + p * 3) % fragments.length];
      const status = [400, 401, 402, 403, 404, 429, 500, 503][i % 8];
      expect(isOurOwnText(formatModelsFetchError(status, body), status), JSON.stringify(body)).toBe(true);
    }
  });

  it("cannot be made to emit text by an evasion that defeats classification", () => {
    // Fail-safe direction: evasion costs the attacker a LESS informative
    // message, never a disclosure.
    const evaded = formatModelsFetchError(418, `cr${ZWSP}ed${NUL}its hunter2`);
    expect(evaded).not.toContain("hunter2");
    expect(isOurOwnText(evaded, 418)).toBe(true);
  });
});

// Invisible characters are deleted before matching, so a keyword split by one is
// still recognised. This closes the evasion without needing the folded text to be
// safe to print — it is never printed.
describe("invisible-character folding", () => {
  it("still classifies a keyword split by an invisible character", () => {
    for (const cp of [0x200b, 0x200e, 0x202e, 0x2060, 0xfeff, 0x00, 0x1b]) {
      const sep = String.fromCodePoint(cp);
      const body = `out of cr${sep}edits`;
      expect(classifyUpstreamError(403, body), `U+${cp.toString(16)}`).toBe("billing");
    }
  });
});

// Review round 4: the body path was clean, but `status` was interpolated raw.
// An object answering 403 to valueOf() and a secret to toString() put attacker
// text into the output THROUGH THE STATUS PARAMETER, and a Symbol threw.
describe("status is not trusted either", () => {
  it("does not emit text supplied through a crafted status", () => {
    const status = { valueOf: () => 403, toString: () => "SECRET" };
    const out = formatModelsFetchError(status, "SECRET");
    expect(out).not.toContain("SECRET");
    expect(out).toBe("Failed to fetch models: unknown status");
  });

  it("does not throw on any status shape", () => {
    const throwing = {
      valueOf() {
        throw new Error("boom");
      },
    };
    for (const status of [Symbol("x"), throwing, null, undefined, NaN, Infinity, 1e99, "abc", {}, [], true]) {
      expect(() => formatModelsFetchError(status, "")).not.toThrow();
      expect(() => classifyUpstreamError(status, "")).not.toThrow();
      expect(() => safeLogDetail(status, "")).not.toThrow();
    }
  });

  it("rejects a status carrying injected newlines", () => {
    expect(formatModelsFetchError("403\ninjected line", "")).toBe("Failed to fetch models: unknown status");
  });

  it("accepts a real status as a number or a numeric string", () => {
    expect(formatModelsFetchError(403, "out of credits")).toContain("403 — out of credits");
    expect(formatModelsFetchError("429", "")).toContain("429 — usage quota");
  });

  it("rejects out-of-range and non-integer statuses", () => {
    for (const status of [99, 600, 403.5, -403]) {
      expect(formatModelsFetchError(status, ""), String(status)).toBe("Failed to fetch models: unknown status");
    }
  });

  it("bounds work on a status supplied as a huge string", () => {
    const started = Date.now();
    expect(formatModelsFetchError(" ".repeat(5_000_000) + "403", "")).toBe(
      "Failed to fetch models: unknown status"
    );
    expect(Date.now() - started).toBeLessThan(500);
  });
});

// Round 5 advisory: both lookup tables were ordinary objects, so a polluted
// Object.prototype could plant a numeric status key or a reason key and steer the
// output. The emitted string must always come from OUR table.
describe("lookups are own-property only", () => {
  it("ignores a reason planted on Object.prototype for an unknown status", () => {
    try {
      Object.prototype[418] = "auth_invalid";
      expect(formatModelsFetchError(418, "")).toBe("Failed to fetch models: 418");
      expect(classifyUpstreamError(418, "")).toBeNull();
    } finally {
      delete Object.prototype[418];
    }
  });

  it("ignores explanation text planted on Object.prototype", () => {
    try {
      Object.prototype.injected = "ATTACKER TEXT";
      expect(explainUpstreamError(418, "injected")).toBe("");
      expect(formatModelsFetchError(418, "injected")).not.toContain("ATTACKER TEXT");
    } finally {
      delete Object.prototype.injected;
    }
  });
});

// Review round 4: several signals were bare substrings, so they matched unrelated
// words and beat the authoritative status fallback.
describe("signals do not fire on unrelated words", () => {
  it("classifies these correctly rather than on a substring accident", () => {
    for (const [status, body, expected] of [
      [404, "model microscope-v2 not found", "not_found"], // /scope/ once won here
      [404, "unblocked region", "not_found"], // /blocked/ matched "unblocked"
      [500, "geometry error", "server"], // /geo/ matched "geometry"
      [500, "certificate expired", "server"], // /expired/ is not always auth
      [500, "cache expired", "server"],
    ]) {
      expect(classifyUpstreamError(status, body), body).toBe(expected);
    }
  });

  it("still fires when the word genuinely applies", () => {
    for (const [status, body, expected] of [
      [401, "token has expired", "auth_expired"],
      [401, "your credentials have expired", "auth_expired"],
      [403, "insufficient scopes", "permission"],
      [403, "missing scope", "permission"],
      [403, "geo-restricted", "blocked"],
      [403, "request blocked", "blocked"],
    ]) {
      expect(classifyUpstreamError(status, body), body).toBe(expected);
    }
  });

  // Round 5: `unsupported` sat before `blocked`, so a geo block was reported as
  // "the upstream does not support listing models" — wrong and unactionable.
  it("prefers the specific blocked signal over the broader unsupported one", () => {
    for (const body of ["region not supported", "country not supported", "unsupported due to policy violation"]) {
      expect(classifyUpstreamError(403, body), body).toBe("blocked");
    }
  });

  it("still reports genuinely unsupported endpoints", () => {
    for (const [status, body] of [
      [405, "method not allowed"],
      [501, "not implemented"],
      [400, "listing models is not supported"],
    ]) {
      expect(classifyUpstreamError(status, body), body).toBe("unsupported");
    }
  });

  it("bounds the match work by slicing before any whole-string operation", () => {
    // trim() on the full body defeated the advertised bound.
    const huge = " ".repeat(5_000_000) + "out of credits";
    const started = Date.now();
    expect(classifyUpstreamError(500, huge)).toBe("server");
    expect(Date.now() - started).toBeLessThan(500);
  });
});

// The raw body used to be logged verbatim, persisting any echoed credential to
// disk — inconsistent with the module's own premise.
describe("safeLogDetail", () => {
  // Reported as chars, not bytes: String#length counts UTF-16 code units, so
  // calling it "B" was wrong for any non-ASCII body.
  it("logs the classification and a length, never the body", () => {
    const body = JSON.stringify({ error: { message: "invalid key sk-abcdef1234567890abcdef" } });
    const out = safeLogDetail(401, body);
    expect(out).not.toContain("sk-abcdef1234567890abcdef");
    expect(out).toBe(`status=401 reason=auth_invalid body=${body.length}chars (not logged)`);
  });

  it("marks an unclassifiable body rather than dumping it", () => {
    const out = safeLogDetail(418, "totally opaque hunter2");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("reason=unclassified");
  });

  it("handles a missing body", () => {
    expect(safeLogDetail(500, undefined)).toContain("body=0chars");
  });
});
