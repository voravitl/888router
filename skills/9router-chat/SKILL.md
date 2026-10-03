---
name: 9router-chat
description: Chat / code generation via 9Router using OpenAI /v1/chat/completions or Anthropic /v1/messages format with streaming + auto-fallback combos. Use when the user wants to ask an LLM, generate code, summarize text, or run prompts through 9Router.
---

# 9Router — Chat

Requires `NINEROUTER_URL` (and `NINEROUTER_KEY` if auth enabled). See /api/skills/raw/9router for setup.

## Endpoints

- `POST $NINEROUTER_URL/v1/chat/completions` — OpenAI format
- `POST $NINEROUTER_URL/v1/messages` — Anthropic format

## Discover

```bash
curl $NINEROUTER_URL/v1/models | jq '.data[].id'
# Per-model metadata (contextWindow, params)
curl "$NINEROUTER_URL/v1/models/info?id=openai/gpt-4o"
```

Combos (e.g. `vip`, `mycodex`) auto-fallback through multiple providers.

## OpenAI format

```bash
curl -X POST $NINEROUTER_URL/v1/chat/completions \
  -H "Authorization: Bearer $NINEROUTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-5","messages":[{"role":"user","content":"Hi"}],"stream":false}'
```

JS (OpenAI SDK):

```js
import OpenAI from "openai";
const client = new OpenAI({ baseURL: `${process.env.NINEROUTER_URL}/v1`, apiKey: process.env.NINEROUTER_KEY });
const res = await client.chat.completions.create({
  model: "openai/gpt-5",
  messages: [{ role: "user", content: "Hi" }],
  stream: true,
});
for await (const chunk of res) process.stdout.write(chunk.choices[0]?.delta?.content || "");
```

## Anthropic format

```bash
curl -X POST $NINEROUTER_URL/v1/messages \
  -H "Authorization: Bearer $NINEROUTER_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"cc/claude-opus-4-7","max_tokens":1024,"messages":[{"role":"user","content":"Hi"}]}'
```

## Response shape

OpenAI (`/v1/chat/completions`):
```json
{ "id": "chatcmpl-...", "object": "chat.completion", "model": "openai/gpt-5",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "Hello!" }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 8, "completion_tokens": 2, "total_tokens": 10 } }
```

Streaming (`stream:true`) emits SSE: `data: {choices:[{delta:{content:"..."}}]}\n\n` ... `data: [DONE]\n\n`.

Anthropic (`/v1/messages`):
```json
{ "id": "msg_...", "type": "message", "role": "assistant", "model": "cc/claude-opus-4-7",
  "content": [{ "type": "text", "text": "Hello!" }],
  "stop_reason": "end_turn", "usage": { "input_tokens": 8, "output_tokens": 2 } }
```


## Claude Code gateway regression lesson

Claude Code requests preserve client semantics by default: native Claude routes
retain system block order, tools, effort/thinking, signatures and cache controls.
Optional compression/style/history transforms require explicit
`x-888-native-transformations: true`; translated combo leaves still need provider
compatibility translation. Same-format Claude SSE ends with Claude lifecycle
events, not an injected OpenAI `[DONE]`. Keep protocol/session headers
request-local and authentication provider-owned.

When comparing a combo with direct access, record the actual provider/model and
first useful text/tool event, not just the first heartbeat or HTTP 200. A fallback
model, a 429, or a malformed tool request is not a valid latency/quality A/B.
Run the Claude passthrough, native stream and header regression suites from the
repo root, then the full suite before release. Source:
[Anthropic gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol).

## Long-context gateway regression lesson

Context capacity belongs to the selected model/provider, not a combo alias or
client `[1m]` suffix. Load persisted provider-scoped limits before routing after
startup, include output reservation, and prefer declared larger-context candidates
without deleting history. Approximate overflow remains eligible for upstream
validation; only explicit output-limit violations are rejected locally without
parking accounts. Unknown limits need upstream validation. Gateway
Unicode-aware counts are estimates; compare full provider usage/count endpoints
before claiming a 500K-token pass.

Long uploads/prefill need bounded larger header/stream-head waits. Preserve
large history and tools instead of optional compression/style transforms by
default. Kiro context-limit failures must not silently shrink the request, and
session prefix caching must not restore an instruction the caller edited.
Verify all four conversation formats and actual selected provider/model;
synthetic payload/parser checks do not establish provider acceptance or task
quality. See `scripts/benchmark-long-context.mjs` and the troubleshooting guide.

Forced-SSE JSON conversion must select its parser from the upstream transport,
retain tool calls and terminal disposition in every client format, and snapshot
raw provider usage before client formatting. Tool-only responses need telemetry
as well. Benchmark actual input thresholds are separate from fixture estimates;
never certify an estimated usage field as provider-measured context.
