// Rewrite path-only /api/skills/raw/ refs to absolute URLs at serve time.
//
// SKILL.md content stores cross-skill refs RELATIVE so the source is portable.
// When serving, we absolutize them against the request origin so agents
// following a link can fetch the next skill without guessing the host.

// Public base URL override: set NINEROUTER_PUBLIC_URL when the gateway is
// behind a proxy/tunnel whose external host differs from the request Host.
// REQUIRED in production/reverse-proxy setups — never trust the raw Host
// header alone for origin derivation.
export function resolveOrigin(requestUrl, env = process.env) {
  if (env.NINEROUTER_PUBLIC_URL) {
    try {
      const u = new URL(env.NINEROUTER_PUBLIC_URL);
      if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
    } catch {
      // malformed env → fall through to request origin; do not 500 the route
    }
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
