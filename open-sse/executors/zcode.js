import { DefaultExecutor } from "./default.js";
import { shouldRefreshCredentials } from "../services/oauthCredentialManager.js";
import { refreshZcodeToken } from "../services/tokenRefresh/providers.js";

// ZCode (Z.ai start-plan) — Anthropic-format plan endpoint, OAuth Bearer auth.
// OAuth flow + refresh live in src/lib/oauth (providers.js) and
// services/tokenRefresh/providers.js respectively. Single-transport provider
// (plan endpoint only serves claude format), so the default transport-aware
// buildUrl/buildHeaders in DefaultExecutor already resolve it — this subclass
// exists for the same reason as CodeBuddyExecutor: credential lifecycle
// (needsRefresh/refreshCredentials) wiring, not URL/header overrides.
export class ZcodeExecutor extends DefaultExecutor {
  constructor(provider = "zcode") {
    super(provider);
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials("zcode", credentials);
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials?.refreshToken) return null;
    return refreshZcodeToken(credentials.refreshToken, log, proxyOptions);
  }
}

export default ZcodeExecutor;
