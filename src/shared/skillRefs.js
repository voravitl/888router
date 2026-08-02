// Rewrite path-only /api/skills/raw/ refs to absolute URLs at serve time.
//
// SKILL.md content stores cross-skill refs RELATIVE so the source is portable.
// When serving, we absolutize them against the request origin so agents
// following a link can fetch the next skill without guessing the host.

// Public base URL override: set NINEROUTER_PUBLIC_URL when the gateway is
// behind a proxy/tunnel whose external host differs from the request Host.
// REQUIRED in production/reverse-proxy setups — never trust the raw Host
// header alone for origin derivation. In production with the env unset we
// FAIL CLOSED (no rewrite + loud warning) rather than poison served markdown
// with attacker-influenced origins.
let warnedMissingPublicUrl = false;

export function resolveOrigin(requestUrl, env = process.env) {
  if (env.NINEROUTER_PUBLIC_URL) {
    try {
      const u = new URL(env.NINEROUTER_PUBLIC_URL);
      if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
      console.error(
        `[Skills] NINEROUTER_PUBLIC_URL has unsupported protocol: ${u.protocol}`
      );
    } catch {
      console.error(
        "[Skills] NINEROUTER_PUBLIC_URL is malformed:",
        env.NINEROUTER_PUBLIC_URL
      );
    }
    if (env.NODE_ENV === "production") return "";
    // dev: fall through to request URL
  }
  if (env.NODE_ENV === "production") {
    if (!warnedMissingPublicUrl) {
      warnedMissingPublicUrl = true;
      console.warn(
        "[Skills] NINEROUTER_PUBLIC_URL is not set in production — skill " +
          "markdown will NOT be rewritten to absolute URLs (fail closed). Set " +
          "it to the gateway's public origin to enable self-hosted skill links."
      );
    }
    return "";
  }
  try {
    const u = new URL(requestUrl);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : "";
  } catch {
    return "";
  }
}

// Replaces path-only refs, leaves absolute URLs (scheme present) untouched.
// Replacer function → no $ interpolation hazards on attacker-controlled origin.
export function absolutizeSkillRefs(content, origin) {
  if (!origin) return content;
  return content.replace(
    /(^|[^:\w])\/api\/skills\/raw\//g,
    (match, p1) => `${p1}${origin}/api/skills/raw/`
  );
}
