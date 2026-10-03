# Troubleshooting

Common issues and solutions when using 9Router.

---

## "Language model did not provide messages"

**Problem:** Request fails with empty response or error message.

**Causes:**
- Provider quota exhausted
- API key invalid or expired
- Model not available

**Solutions:**

1. **Check quota status:**
   ```
   Dashboard → Providers → View quota tracker
   ```
   If quota is exhausted, wait for reset or switch provider.

2. **Use combo fallback:**
   ```
   Dashboard → Combos → Create fallback chain
   Example: cc/claude-opus → glm/glm-4.7 → if/kimi-k2
   ```

3. **Verify provider connection:**
   ```
   Dashboard → Providers → Reconnect if needed
   ```

---

## Rate Limiting

**Problem:** "Rate limit exceeded" or "Too many requests" errors.

**Causes:**
- Subscription quota depleted (5-hour/daily/weekly limits)
- API rate limits hit
- Too many concurrent requests

**Solutions:**

1. **Check reset time:**
   ```
   Dashboard → Quota Tracking → View reset countdown
   ```

2. **Switch to cheap tier:**
   ```
   Use: glm/glm-4.7 ($0.6/1M tokens)
        minimax/MiniMax-M2.1 ($0.20/1M tokens)
   ```

3. **Add fallback combo:**
   ```
   Dashboard → Combos → Add backup models
   Primary: cc/claude-opus (subscription)
   Backup: glm/glm-4.7 (cheap)
   Emergency: if/kimi-k2 (free)
   ```

---

## OAuth Token Expired

**Problem:** "Unauthorized" or "Token expired" errors.

**Causes:**
- OAuth token expired (auto-refresh failed)
- Provider session invalidated
- Network issues during refresh

**Solutions:**

1. **Auto-refresh (default):**
   9Router automatically refreshes tokens. Wait 30 seconds and retry.

2. **Manual reconnect:**
   ```
   Dashboard → Providers → [Provider Name] → Reconnect
   → Complete OAuth flow again
   ```

3. **Check provider status:**
   Verify provider service is online (Claude Code, Codex, etc.)

---

## High Costs

**Problem:** Unexpected high usage or costs.

**Causes:**
- Using expensive models unnecessarily
- No fallback to cheaper tiers
- Large context windows

**Solutions:**

1. **Check usage stats:**
   ```
   Dashboard → Usage Stats → View token consumption
   → Identify high-cost models
   ```

2. **Switch to cheaper models:**
   ```
   Replace: cc/claude-opus ($20-100/month subscription)
   With: glm/glm-4.7 ($0.6/1M tokens)
         minimax/MiniMax-M2.1 ($0.20/1M tokens)
   ```

3. **Use free tier:**
   ```
   if/kimi-k2-thinking (FREE)
   qw/qwen3-coder-plus (FREE)
   kr/claude-sonnet-4.5 (FREE)
   gc/gemini-3-flash-preview (FREE 180K/month)
   ```

4. **Optimize prompts:**
   - Reduce context size
   - Use streaming for long responses
   - Cache common prompts

---

## Connection Refused

**Problem:** "ECONNREFUSED" or "Cannot connect to localhost:20128".

**Causes:**
- 9Router not running
- Port 20128 blocked
- Firewall blocking connection

**Solutions:**

1. **Start 9Router:**
   ```bash
   9router
   ```
   Dashboard should open at http://localhost:3000

2. **Verify port 20128:**
   ```bash
   # Check if port is listening
   lsof -i :20128
   
   # Or on Windows
   netstat -ano | findstr :20128
   ```

3. **Check firewall:**
   - macOS: System Settings → Network → Firewall
   - Windows: Windows Defender Firewall → Allow app
   - Linux: `sudo ufw allow 20128`

4. **Use cloud endpoint:**
   If localhost doesn't work (e.g., Cursor IDE):
   ```
   Endpoint: https://9router.com/v1
   ```

---

## Dashboard Not Opening

**Problem:** Dashboard doesn't load at http://localhost:3000.

**Causes:**
- Port 3000 already in use
- 9Router crashed
- Browser cache issues

**Solutions:**

1. **Check if 9Router is running:**
   ```bash
   # Check process
   ps aux | grep 9router
   
   # Check port 3000
   lsof -i :3000
   ```

2. **Kill conflicting process:**
   ```bash
   # macOS/Linux
   lsof -ti:3000 | xargs kill -9
   
   # Windows
   netstat -ano | findstr :3000
   taskkill /PID <PID> /F
   ```

3. **Restart 9Router:**
   ```bash
   # Stop
   pkill -f 9router
   
   # Start
   9router
   ```

4. **Clear browser cache:**
   - Chrome: Ctrl+Shift+Delete → Clear cache
   - Try incognito mode

5. **Check firewall settings:**
   Ensure port 3000 is not blocked.

---

## Model Not Found

**Problem:** "Model not found" or "Invalid model" errors.

**Causes:**
- Provider not connected
- Model ID typo
- Provider inactive

**Solutions:**

1. **Verify provider connection:**
   ```
   Dashboard → Providers → Check status (green = active)
   ```

2. **Check model ID format:**
   ```
   Correct: cc/claude-opus-4-5-20251101
   Wrong: claude-opus-4-5-20251101
   
   Format: [provider-prefix]/[model-name]
   ```

3. **List available models:**
   ```bash
   curl http://localhost:20128/v1/models \
     -H "Authorization: Bearer your-api-key"
   ```

4. **Reconnect provider:**
   ```
   Dashboard → Providers → [Provider] → Reconnect
   ```

---

## Slow Response

**Problem:** Requests take too long or timeout.

**Causes:**
- Provider latency
- Network issues
- Large context/response
- Provider rate limiting

**Solutions:**

1. **Check provider status:**
   ```
   Dashboard → Providers → View latency stats
   ```

2. **Switch to faster model:**
   ```
   Fast: cc/claude-haiku-4-5 (Haiku is faster than Opus)
         gc/gemini-3-flash-preview
         qw/qwen3-coder-flash
   ```

3. **Use streaming:**
   ```json
   {
     "model": "cc/claude-opus-4-5",
     "messages": [...],
     "stream": true
   }
   ```

4. **Check network:**
   ```bash
   # Test latency
   ping api.anthropic.com
   ping api.openai.com
   ```

5. **Reduce context size:**
   - Trim message history
   - Use smaller prompts
   - Enable context pruning in CLI tool

---

## API Key Invalid

**Problem:** "Invalid API key" or "Authentication failed" errors.

**Causes:**
- Wrong API key copied
- API key expired
- API key not generated

**Solutions:**

1. **Regenerate API key:**
   ```
   Dashboard → Settings → API Keys → Generate New Key
   → Copy and use new key
   ```

2. **Verify key format:**
   ```
   Correct: 9r_xxxxxxxxxxxxxxxxxxxxxxxx
   Wrong: Missing 9r_ prefix
   ```

3. **Check key in CLI config:**
   ```bash
   # Cursor
   Settings → Models → OpenAI API Key
   
   # Cline
   Settings → API Key
   
   # Environment variable
   export OPENAI_API_KEY="9r_your_key"
   ```

4. **Test API key:**
   ```bash
   curl http://localhost:20128/v1/models \
     -H "Authorization: Bearer 9r_your_key"
   ```

---

## A new OpenAI model is missing from Codex sync

OpenAI API and OpenAI Codex have separate provider registries. Adding a model to the OpenAI API registry does not add it to Codex. A successful sync preserves upstream entries and supplements missing entries from the selected provider's registry.

Codex sync automatically reads the latest stable release version from the official `@openai/codex` npm package and uses it for authenticated model discovery. Each successful Sync refreshes this version, so new upstream model IDs do not require a registry edit. Upstream names, context limits and image support remain authoritative; chat models receive review variants automatically.

If release metadata is unavailable, sync uses the last known version (or the bundled baseline), displays a warning, and retries the release lookup after a one-minute backoff. Concurrent syncs share the release lookup; model catalogs remain account-specific. Only public release metadata goes to npm, with no provider credentials. Sync cannot make models available before the provider exposes them to the account. A catalog entry alone does not prove account access.

## Need More Help?

- **GitHub Issues:** [github.com/decolua/9router/issues](https://github.com/decolua/9router/issues)
- **Documentation:** [9router.com/docs](https://9router.com/docs)
- **FAQ:** [faq.md](faq.md)


### Claude Code behaves differently through a gateway

Claude Code requests default to preserving client semantics. For native Claude
Messages routes, 888router forwards the request body with only the resolved model
changed. Client thinking, effort, tools, system blocks, history, extensions, and
cache controls remain client-owned. Provider thinking defaults, tool deduplication,
RTK, Headroom, pruning, Caveman/Ponytail, and automatic cache rewriting do not run
by default on Claude Code requests. Cross-provider combo leaves still require
protocol translation and the selected provider's compatibility constraints.

To explicitly use the configured request transformations, send
`x-888-native-transformations: true`. This can change model behavior and cache
reuse. Native Claude SSE preserves upstream bytes and event order, including
pings, thinking signatures, partial tool arguments, and unknown future events.
It does not append an OpenAI `[DONE]` sentinel. An interrupted native stream
propagates the upstream failure without fabricating a successful completion.

A combo can fall back to a different provider or model. Compare the actual
resolved provider/model, client version, effort, cache state, first useful text
or tool event, total time, and task success before drawing conclusions about
performance. A proxy cannot guarantee higher throughput or answer quality than
the same upstream provider. Claude Code also has different fine-grained tool
streaming defaults for a custom base URL. See Anthropic's
[Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol).

### Long context and heavy tool workloads

A gateway cannot give every model the same context window. Check the actual
provider, model, account access, and requested output budget. A model catalog or
successful short request does not establish support for a 500K-token request.
Unknown models remain eligible for upstream validation; an unknown limit is not
advertised as unlimited capacity.

The gateway uses a Unicode-aware estimate of text, instructions, tool definitions,
and conversation history for routing. It includes the requested output budget
when comparing known context limits and prefers candidates with enough declared
capacity. Estimated overflow candidates remain available for authoritative
upstream validation; character estimates do not cause definitive local input
rejection. Explicit output budgets exceeding a declared output limit are
rejected locally without changing account health. This estimate is not the provider's tokenizer and does
not establish the cost of images, audio, video, documents, or opaque reasoning
state. Use provider token-count endpoints where available and compare the
provider's returned usage. OpenAI documents
[Responses input token counting](https://developers.openai.com/api/docs/guides/token-counting)
and Gemini documents
[countTokens](https://ai.google.dev/api/tokens).

Large requests receive a longer, bounded wait for response headers and the first
stream chunk rather than the ordinary short request budget. A stalled stream or
exhausted total time budget still fails; waiting longer does not expand the
upstream model's context limit. For requests estimated at 100K input tokens or
more, the large-request header/first-chunk budget defaults to 180 seconds
(`LONG_CONTEXT_TIMEOUT_MS`), the stream-head idle budget to 60 seconds, and the budget for starting
fallback candidates to 360 seconds. These are not limits on the total duration
of a healthy response stream.

Kiro does not automatically discard history to retry a context-limit error by
default. `providerSpecificData.kiroAllowContextTruncation: true` explicitly enables
the legacy reduction behavior on a cloned request and emits a warning; enabling
it can remove information needed for the task. Prefer a suitable larger-context
model or explicit client compaction.

Claude Code may use a 200K default for an unrecognized custom model alias even
when its upstream model supports more. Configure the client's model metadata
according to the
[Claude Code gateway guide](https://code.claude.com/docs/en/llm-gateway-protocol#settings-for-unrecognized-model-ids).
Client context metadata must describe the models the alias can actually select.

Run the offline large-payload diagnostic from the repository root:

```bash
node scripts/benchmark-long-context.mjs
```

It generates 50K, 200K, and 500K routing estimates in Anthropic Messages, OpenAI
Chat Completions, OpenAI Responses, and Gemini formats. Each format exercises
Unicode text, previous tool calls/results, and retrieval of unique markers at
the beginning, middle, and end. The checks validate JSON round trips and response
parsers against synthetic valid, incorrect, incomplete, and failed replies.
They do not call the gateway or prove provider acceptance or reasoning quality.

Live testing is opt-in and may incur provider charges. Select an existing model
or combo that is expected to support the requested context. With
`LONG_CONTEXT_SQLITE=true`, the script reads an active gateway API key from the
running `888route` container's SQLite database in read-only mode. Alternatively,
provide `LONG_CONTEXT_API_KEY` through the environment. It never prints keys,
headers, request bodies, or response text.

```bash
LONG_CONTEXT_LIVE=true LONG_CONTEXT_SQLITE=true \
LONG_CONTEXT_MODEL=your-configured-model-or-combo \
LONG_CONTEXT_FORMATS=openai-chat LONG_CONTEXT_SIZES=50000 \
node scripts/benchmark-long-context.mjs
```

Supported format values are `anthropic`, `openai-chat`, `responses`, and `gemini`;
comma-separated formats and sizes are supported. Live mode defaults to one
format at 50K and sends text and tool tasks sequentially. Set
`LONG_CONTEXT_BASE_URL` to the gateway origin if it is not
`http://localhost:20129`. `LONG_CONTEXT_TIMEOUT_MS` sets the benchmark's per-request
client deadline (default 180 seconds, maximum 600 seconds); it does not configure
the running gateway. JSON response capture is capped at 1 MiB.

The summary includes estimated input, available response usage, status, timings,
returned model, and an optional nonce-matched provider/model/account routing
trace from read-only telemetry. Missing telemetry is reported as unavailable.
These are non-streaming retrieval/tool smoke checks, not a streaming endurance,
concurrency, cache-equivalence, or direct-provider performance benchmark. An
upstream context rejection, fallback, timeout, or truncated/incomplete answer
must not be counted as a successful large-context run.

In live results, `pass` means the HTTP request completed and the marker/tool task
passed. It does **not** certify the context size. `actualTotalInputTokens` includes
Anthropic's input, cache-read, and cache-creation tokens; other formats' prompt
counts already include cached input. `contextTargetMet` compares that reported
count with `targetMeasuredTokens` (defaults to the estimated target). Set
`LONG_CONTEXT_MIN_ACTUAL_INPUT_TOKENS=500000` with, for example,
`LONG_CONTEXT_SIZES=800000` to test at least 500K actual input tokens despite
tokenizer differences. Choose a model that accepts the generated request; this
setting changes only the benchmark threshold, never the gateway input or usage.
Measurement requires nonce-matched,
read-only request telemetry containing the unmodified provider response usage
(`LONG_CONTEXT_SQLITE=true`). Estimated usage, gateway-padded client counts,
and unavailable telemetry do not certify the target. Oversized response previews
retain bounded raw usage separately; full response bodies remain truncated. The
fixture places its unique trace nonce in the tool description and first-message
preview so tool-only runs remain attributable when saved inputs are truncated. Missing or invalid counts produce
`contextVerification: "not_measured"`; smaller counts produce
`"below_requested_target"`. Tokenizer differences can cause a smaller actual
count even when the task succeeds, so this is reported separately from semantic
success. `measuredContextTaskPass` requires task success and a provider-reported
count at the target, with no observed response/telemetry model mismatch. Even
that does not prove that every history entry was retained or used correctly.

`actualSelectedLeaf` records the telemetry-selected provider/model/account when
available, otherwise only the response model. Requested aliases and returned
model IDs may differ. Response/telemetry disagreement is reported explicitly;
no result is classified as a direct-provider comparison. `headersMs` and
`totalMs` describe non-streaming response headers and completion, respectively,
rather than time to the first useful streamed token.

The Gemini `generateContent`/`streamGenerateContent` endpoint passes native
`contents`, function calls/results, tools, media parts, generation settings,
and extensions to the shared provider translator. It preserves full
provider/model paths and takes streaming intent from the URL action. Its response
adapter preserves native Gemini output and translates OpenAI-shaped tool calls,
including fragmented streamed arguments, without reducing requests to text-only
messages. Native Gemini audio/TTS requests retain their dedicated forwarding path.

### Provider-specific transport limits

Long-input handling cannot raise an upstream model's context limit. AiPASS's browser bridge cannot preserve a long multi-turn request and returns `unsupported_request`, allowing a configured combo to try another provider. Qoder retains its normal 120-second header wait and extends it for long input. Cursor's buffered HTTP/2 response uses the long-request budget; this is a whole buffered-response deadline, not a streaming idle timeout. Healthy streaming responses are not universally cut off after the combo's candidate-start budget.
