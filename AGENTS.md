## Delivery rules (applies to EVERY agent/tool working in this repo)

These rules are tool-agnostic. Hermes, Claude Code, Codex, Grok, Agy, OpenCode
and any human contributor follow the same pipeline. Do not invent a shortcut
because your tool makes one convenient.

### Never hotfix a running container

The deployed workload runs a published image (`voravitl/888router:*`) under
**docker compose** and does **not** mount this source tree. Editing files here
changes nothing — the bundled code in `/app/.next` inside the running container
still holds the old logic. Every change ships through the pipeline below.

The `k8s/` manifests remain in the repo but are **not deployed** (2026-09-30,
issue #501). Nothing in the delivery pipeline applies them; treat them as
inert reference, not a deploy target.

### Pipeline (do not skip steps)

1. **Branch first.** Never commit the fix directly to `master`.
2. **Evidence before edit.** For any capability/model/pricing claim, cite a real
   source (`models.dev` API, provider docs, an observed upstream error). No
   guessing, no "probably".
3. **Test.** `npx vitest run --config tests/vitest.config.js` from the **repo
   root** (running it from `tests/` breaks `path.resolve("src/...")` suites).
   All tests must pass. A version bump legitimately moves the
   `golden-url-header` snapshots — refresh them with `-u` and commit that as a
   separate, clearly-labelled commit.
4. **Self-review.** See "Review is mandatory — the reviewer is you" below.
5. **Version + changelog.** Bump `package.json` **and** `package-lock.json`
   (regenerate via `npm install`, do not hand-edit the version strings) and add
   a `CHANGELOG.md` entry **before** tagging. Keep the changelog claim no
   broader than the diff actually is.
   - **HARD RULE (2026-10-01): every code-fix MR carries its own bump.** The
     version bump commit lives INSIDE the same PR as the fix (fix commit(s)
     first, bump commit last), never as a follow-up after merge. A merged fix
     without a bump publishes an image whose code moved but whose
     `/api/version` did not — undeployable and unverifiable (lesson from
     #503, merged at 0.15.141 with new code). `closes #N` + bump in one MR.
   - `package.json` + `CHANGELOG.md` are the only version-bearing files. The
     `k8s/` image references (`k8s/base/888router.yaml` + `overlays/local` +
     `overlays/prd`) are **not** part of the ship path any more — k8s is not
     deployed (issue #501). Leave them alone; do not bump them.
6. **Deploy: docker compose, and nothing else.**
   - CI (`docker-publish.yml`) **publishes the image only** — it has no deploy
     job. The `deploy-local-kubernetes` job was removed 2026-09-30 (issue #501)
     precisely because it raced manual deploys: a manual `kubectl apply` after
     merge was overwritten by CI minutes later (double 503, incident
     2026-09-28). Do not reintroduce a CI deploy job.
   - **Update path (normal case).** The `888route` service (host port 20129 —
     the live gateway) carries `com.centurylinklabs.watchtower.enable=true`
     and the watchtower name filter tracks it, so a new `:latest` is pulled
     and recreated on the host within `WATCHTOWER_POLL_INTERVAL` (300s).
     Wait for `Build and Push Docker Image` on master, then verify only:
      `gh run list --workflow docker-publish.yml --limit 1`
      `curl http://localhost:20129/api/version` (must equal `package.json` version)
      `docker compose ps 888route`
   - **Manual update path (when you need it now).** Watchtower is a safety net,
     not the thing to wait on:
      `docker compose pull 888route && docker compose up -d 888route`
   - **NEVER `kubectl apply`.** It deploys nothing compose serves, and `k8s/`
     drifting away from the running image is a silent trap.
   - **Rollback:** repoint `888route.image` at the previous release tag (or pin
     via the local `docker-compose.override.yml`), then
     `docker compose up -d 888route`.
   - **SQLite is single-writer per volume.** `888route-data` is the live DB —
     never mount it into a second gateway container. The `888router` service
     entry in compose is defined but NOT run; if it is ever started it must
     keep its own `888router-data` volume.
7. **Capture.** Record the lesson in the wiki/skill so the next agent does not
   repeat the mistake.

Nothing is "done" until `git log`, `/api/version` and the live compose container
all agree.

### Review is mandatory — the reviewer is you

**Changed 2026-10-21 (owner decision): every code change is reviewed BY THE
WRITING AGENT ITSELF. Do NOT dispatch the diff to another model, CLI, or
service for review. The ladder below is retired.**

The previous rule required an "independent" reviewer from another model. That
is no longer the process. The agent that writes the diff also reviews it, and
that review is the gate.

What "reviewing it yourself" means in practice — all of it is required:

- **Re-read the diff as a stranger.** `git diff <base>..HEAD` and read every
  hunk as if you had never seen the base file. Ask: what does this change
  break? What input makes this wrong?
- **Re-read the FULL file for anything you touched**, not just the hunks. A
  diff-only read is the classic source of "missing wiring" false positives
  and false negatives.
- **Write the failing test FIRST, then fix.** For every behavioural change,
  add a regression test that fails on the base commit and passes on the branch.
  If you cannot write a test that fails without your fix, you do not yet
  understand the bug.
- **Prove the fix on the real artifact**, not a proxy: run the actual path
  (real request, real stream, real container), read the actual output value.
  "It compiles" and "CI is green" are not proof.
- **Hunt the boundary cases yourself.** Empty/null/missing field, zero-length
  string, single-element array, duplicate aliases, trailing-newline framing,
  the value that arrives at the exact end of the stream. These are where
  every real bug in this repo has lived.
- **Check for regressions in the OLD behaviour.** For each thing you changed,
  ask what used to work that must still work. Run the FULL suite
  (`npx vitest run --config tests/vitest.config.js` from the repo root), not
  only your new tests.
- **Verify the claim in the CHANGELOG matches the diff**, and no broader.
- **Re-read the final diff after the last edit.** The version bump, the
  snapshot refresh, and the source fix must all be in the same PR.

Severity gate, applied by you to your own diff:

- Resolve every issue you find at CRITICAL or HIGH before merge.
- MEDIUM and LOW: fix when the fix is small and safe; otherwise record them
  explicitly (changelog or PR description) as a follow-up so the next agent
  inherits them. Do not silently drop a known issue.
- If you find a problem you cannot fix, report it — do not merge a diff you
  know is broken.

Keep the history of the old process for context, but it is **not** in force:

<details>
<summary>Retired: the independent-reviewer ladder (pre-2026-10-21)</summary>

Every code change used to get an independent review from a model that did
**not** write it, with this fallback ladder (top preferred; descend until one
returns real findings):

| Rank | Reviewer | How |
|------|----------|-----|
| 1 | Grok 4.6 (`grok` CLI) | `cat /tmp/pr.diff \| grok -p "<review prompt>"` |
| 2 | `9-opus` via 888router | `python3 ~/.hermes/scripts/888router-review.py --model 9-opus --file /tmp/pr.diff` |
| 3 | `cc/claude-opus-4-8` via 888router | same script, `--model cc/claude-opus-4-8` |
| 4 | Claude Opus Thinking (`agy` CLI) | `cat /tmp/pr.diff \| agy -p "<review prompt>"` |
| 5 | `codex` CLI | `codex exec "review this diff: ..."` |
| 6 | `kr/claude-opus-4-8-thinking` via 888router | same script |

The lessons that came out of that process are still worth keeping, because
they are about the diff, not about who reviews it:

- **Verify "missing wiring" findings against the full file first** — a
  reviewer (or you, reading only the diff) will false-positive on symbols
  already used in the base file.
- **Security/auth diffs deserve extra scrutiny** — read the whole auth path,
  not the hunk.
- A blind "one more model says APPROVE" is not evidence. Neither is a clean
  run of a suite you did not read. Read the code.

</details>

**What did NOT change:** the rest of the delivery pipeline is untouched. Branch
first, evidence before edit, full test suite green, version bump + changelog in
the same PR, deploy via docker compose only, and the squash-merge source-hunk
check below. Those rules were not about the reviewer, and they still hold.

### Squash merges can silently drop hunks — verify the merge tree, not the exit code (2026-10-16, PRs #545/#546)

- PR #545's `--squash` landed its package bump, CHANGELOG, snapshot refresh and
  four NEW test files but **zero source hunks**: 21 of those committed tests
  failed on a clean checkout of `3fe3bf10`, and the deployed 0.15.166 image
  carried none of the advertised fixes while `/api/version` said otherwise.
  PR #546 restored the payload and the fix shipped verified, but the accident
  is repeatable.
- Therefore, before AND after every squash merge: pre-merge, enumerate the
  PR's files (`gh pr view --json files`) and refuse to merge if source files
  are missing; post-merge, inspect the squash tree (`git show --stat <sha>`
  or `git show <sha>:<file> | grep <landmark>`). A clean local `git status`
  and a green build prove nothing — "Build and Push Docker Image" does **not**
  run vitest, so CI success has never meant tests pass in this repo.
- Signature to watch for: a squash commit that adds test files touching code
  that the same commit never modifies. That combination always deserves a
  clean-checkout test run before trusting the merge.

### Capability-table edits (`open-sse/providers/capabilities.js`)

- Prefer explicit `vision: false` over omission when a model genuinely cannot
  accept images. Omission means "unspecified" and silently changes meaning if
  defaults ever change.
- Fix the **whole family**, not one model ID. Grep every occurrence and alias
  before claiming family-level scope in the changelog.
- Structural fix over per-model patch: if new models of the same family will
  keep hitting the bug, fix the resolution mechanism instead of enumerating IDs.

### Docker entrypoint vs. hardened k8s securityContext (v0.15.99 → v0.15.100)

**Historical (k8s era, no longer the deploy path).** Kept because the
entrypoint lesson still applies to compose and to any hardened runtime.

Symptom seen in prod: pod `CrashLoopBackOff`, container logs show only
`su-exec: setgroups: Operation not permitted`, and the ingress serves **503** because
0/1 backends are Ready.

Root cause: an entrypoint that runs `su-exec` (or `gosu`) **unconditionally** calls
`setgroups()`, which needs `CAP_SETGID`. Our k8s `securityContext` is `runAsNonRoot: true`,
`runAsUser: 1000`, `capabilities.drop: [ALL]`, `allowPrivilegeEscalation: false`, so
`setgroups()` returns `EPERM` and the process exits 1. `su-exec` is only usable when the
container **starts as root** (the plain-Docker case) — never on the already-non-root k8s
path. This shipped in image `0.15.99` (added by commit `8c51edab`, "use entrypoint to fix
/app/data permissions").

Rule for any privilege-drop entrypoint — make it **dual-mode** (see `docker-entrypoint.sh`):

```sh
if [ "$(id -u)" = "0" ]; then chown -R node:node /app/data …; exec su-exec node "$@"; fi
exec "$@"   # already non-root (k8s): NEVER touch su-exec/setgroups here
```

The deployment landmine that turned a fixed bug back into an outage: the Dockerfile was
fixed on `master` but the release was **not versioned** (`package.json` stayed `0.15.99`)
and the deploy target still pinned the poisoned tag, so the next deploy re-pulled
`0.15.99` and re-broke prod. Therefore:

- A code fix is **not shipped** until `package.json` / `package-lock.json` / `CHANGELOG`
  move to the new tag together, and the running container actually reports it
  (`curl http://localhost:20129/api/version`). Grep `grep -rn 0.15.<old> package.json`
  before calling it done.
- Treat a known-bad published tag as **burned**: supersede it with a new version, never try
  to "reuse"/overwrite it.
- Verify a privilege / securityContext change locally before deploying:
  `docker run --user 1000 --cap-drop ALL --security-opt no-new-privileges … <image>` must
  reach Ready, and the root path must end with PID 1 at uid 1000 (`cat /proc/1/status`).
- Fast incident mitigation is `docker compose up -d 888route` on the previous
  release tag (`docker compose pull` that tag first).

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, invoke the `skill` tool with `skill: "graphify"` before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

### Anthropic identity line is an entitlement, not an instruction (2026-10-19, v0.15.171)

`api.anthropic.com` refuses any request whose `system` carries the exact string
`"You are Claude Code, Anthropic's official CLI for Claude."` when it is
authenticated with an API key: `400 invalid_request_error`, "Your credit balance
is too low to access the Anthropic API", raised before the model runs. The same
line is accepted on subscription (`sk-ant-oat`) traffic. Verified live:
exact block → 400; without trailing period → 200; embedded in other text → 200;
no system → 200. Both the OpenAI→Claude bridge (injection) and Claude Code
clients (which send it themselves) trigger it.

Rules going forward:
- Inject `CLAUDE_SYSTEM_PROMPT` only with a subscription (`sk-ant-oat`) credential — never for API-key providers. Gate on the credential, not just the provider id.
- Any official Anthropic API-key path must strip the line from `body.system` (string and block-array shapes); empty blocks must be dropped, not left as empty text.
- Keep the OAuth path untouched — it requires the identity and is accepted.
- Shared helper: `open-sse/translator/concerns/claudeCodeIdentity.js`
  (`stripClaudeCodeIdentity`, `stripClaudeCodeIdentityFromBody`,
  `isClaudeOAuthCredential`, `OFFICIAL_ANTHROPIC_PROVIDERS`). Reuse it instead
  of re-implementing the regex per provider (antigravity.js already had a
  private copy — consolidate if touching that area).

### OpenAI-compatible upstreams reject both max_tokens and max_completion_tokens (2026-10-19, v0.15.172)

opencode-go's Go tier (and OpenAI itself) returns
`400 invalid_request_error "'max_tokens' and 'max_completion_tokens' cannot be
set together."` when both are present. Verified live: each alone → 200, both → 400.

Rule: at the chat boundary, when both fields are present on an OpenAI-compatible
target, keep `max_completion_tokens` and delete `max_tokens` (after
`alignTranslatedOutputBudget`). Claude-format traffic uses `max_tokens` only
and must be left untouched. Boundary guard lives in
`open-sse/handlers/chatCore.js`.

### `noAuth` is dropped by `buildTransport` (2026-10-19)

`open-sse/providers/index.js` `buildTransport` copied `hasFree`/`authType`/`maxTools`
but not `noAuth`, so `PROVIDERS.opencode.noAuth` (and many others) was
`undefined` and `BaseExecutor.noAuth` was always `false`. That defeated the
"skip token refresh for noAuth providers" guards in chatCore/imageGenerationCore/
embeddingsCore, producing `[TOKEN] OPENCODE | refresh failed` +
`[TOKEN_REFRESH] All 3 retry attempts failed` on every 403.

Rule: any new policy flag added to a registry entry must be copied in
`buildTransport` (mirroring `hasFree`/`authType`/`maxTools`), and the
`v1-models-noauth-virtual-injection` test pins this invariant.

### A client format can be adapted OUTSIDE the translator layer (2026-10-21, v0.15.179)

The Gemini client format (`/v1beta/models/...`) has **no** `openai → gemini`
response translator registered, so `open-sse/` leaves the chunk OpenAI-shaped
and the endpoint adapter in `src/app/api/v1beta/models/[...path]/route.js`
(`transformOpenAISSEToGeminiSSE`, `convertOpenAIResponseToGemini`) does the
conversion. That adapter only read `content`, so the 0.15.178 refusal fix
never reached a Gemini client — a refusal-only answer arrived as
`parts: [{"text": ""}]`. Fixed in 0.15.179.

Rule: "the client format is handled" is only true when every layer between
the provider response and the wire is checked. Before claiming a format is
covered, grep for the shape you are emitting (`candidates:`, `parts:`,
`text_delta`, `output_text`) — the converter may live in a route handler, not
in `open-sse/translator/`. Test the adapter that actually runs, not the one
that looks right.

Known gap (recorded, not fixed): `open-sse/handlers/responsesHandler.js`
(`handleResponsesCore`) is dead code — nothing imports it — and it still has
the original whole-completion bug (reads only `choice.delta`). It cannot
affect traffic today; delete it rather than fix it if it is ever revived.

### The CI gate is the FULL suite, run from the repo root with the PINNED vitest (2026-10-21)

CI used to run a hand-picked smoke list — 8 of 349 test files in `ci.yml` and
a *different* 10 in `docker-publish.yml` (2.3% / 3.4% coverage, and the two
lists disagreed). The 22 refusal-delivery cases added in #556 and #557 were
in neither, so CI stayed green on a build that shipped a regression in exactly
those paths. Both workflows now run the full suite (3,615 passed / 0 failed /
70 skipped — identical on macOS and on a Linux container) plus
`tests/__baseline__/verify-no-regression.mjs`, and `docker-publish.yml` also
runs `npm run build` before the image is built.

Two non-obvious details that a future agent will otherwise undo:

- **Run vitest from the REPO ROOT.** From `tests/`, the suites that resolve
  sources with `path.resolve("src/...")` fail — `security-audit.test.js` alone
  failed 15 cases that way. The suite is green only from the root.
- **Invoke `./tests/node_modules/.bin/vitest`, not `npx vitest`.** The root
  `package.json` has no vitest dependency; the pinned one (`4.x`) lives in
  `tests/node_modules`. `npx vitest` from the root therefore resolves a
  *different* major from the registry — verified locally: npx served 5.0.5
  against the pinned 4.1.10. A gate that runs a different test runner than
  the one you validated against is not a gate.

Rule: a new test file needs no registration anywhere — the full-suite gate
picks it up on the next run. If you ever re-introduce a smoke subset, it must
be a *supplement* to the full run, never a replacement for it.

### A golden snapshot must never encode the machine that produced it (2026-10-21, v0.15.180)

Turning the full-suite gate on failed immediately on the Linux CI runner with
5 failures the macOS box could not reproduce. Every one of them was a
**test-side** portability bug, and every one of them had been invisible
because the file was in no smoke list:

- `tests/translator/golden-url-header.test.js` recorded the host's own
  identity in the snapshot: `X-PLATFORM` (`process.platform`),
  `X-PLATFORM-VERSION` (`process.version`), `X-Msh-Device-Model`
  (`${process.platform} ${process.arch}`) and `X-Msh-Device-Name`
  (`hostname()`). The snapshot said `darwin`; the runner produced `linux`
  and its own hostname. Three separate rounds of failure — one per leak.
- `tests/unit/devin-cli-executor.test.js` asserted `XDG_CONFIG_HOME` is
  `undefined`, but the executor legitimately forwards a pre-existing
  `XDG_CONFIG_HOME` through its `SAFE_ENV_KEYS` allowlist. The assertion
  tested the HOST environment, not the executor. Linux runners export
  `/home/runner/.config`; macOS usually exports nothing.

Rules going forward:

- **A golden/snapshot file records the gateway's behaviour, never the
  machine's.** If a value comes from `process.platform`, `process.arch`,
  `process.version`, `os.hostname()` or a path, it must be normalized before
  it reaches the snapshot — the assertion that matters is the header's
  PRESENCE, not its value.
- **A test must assert the unit's behaviour, not the ambient environment.**
  "The executor does not set X" is a statement about the executor; asserting
  `toBeUndefined()` on a variable the parent process may already export
  asserts the parent process instead. Read the source before writing the
  assertion.
- **The list of normalized fields cannot be trusted to stay complete.** A new
  provider can start emitting a new host-derived header. So the guard is
  structural, not a list: `golden-url-header.test.js` runs the header dump
  TWICE in two processes — the real host, and one where every source of host
  identity is replaced by a canary (`golden-url-header.host-canary.cjs`,
  loaded with `--require` so it patches `os.*` BEFORE the application
  modules are imported, because `shared.js` and `appConstants.js` capture
  `os.platform()` / `os.arch()` / `os.hostname()` at MODULE LOAD time). Any
  header whose value differs between the two runs is host-derived, and the
  guard names the provider and the header.
- **A perturbation beats a value-pattern.** The first version of the guard
  compared header values against "looks like a platform" strings and
  false-positived on `claude`'s `X-Stainless-Arch: arm64` — a HARDCODED
  spoof constant that merely happened to equal the maintainer's real arch.
  Perturbing the identity and comparing is exact.

Proof that this works: injecting a brand-new host-derived header
(`X-Msh-New-Leaky-Header`) into `open-sse/config/appConstants.js` makes the
guard fail with the provider and the header named, before the snapshot ever
gets a chance to disagree on somebody else's machine.

Corollary: a local green run proves nothing about CI. The Linux container
run (`node:22-bookworm`, Node 22.23.3 — the runtime CI uses) is what
confirmed the suite is machine-independent: 3,615 passed / 0 failed / 70
skipped, identical to macOS.

### A model-identity error must never park a SHARED proxy pool (2026-10-21, v0.15.181)

opencode.ai answers **410 `ModelDeprecated`** for a retired model id. 410
matched no rule in `ERROR_RULES`, so it fell through to the default
transient rule (`shouldFallback: true`, 30 s) and `markAccountUnavailable`
**parked the shared relay pool** for 30 s. That relay is shared by every
`oc/*` model, so one dead id killed all of them — each answering with the
same 410 body, naming a model the caller never requested. Live proof
(`docker logs 888route`):

```
[AUTH] pool 811de521-… parked 30s [410] backoff=0
[AUTH] opencode | all proxy pools parked [410], retry after reset after 26s
[CHAT] [opencode/beam-free] [410]: {"type":"error","error":{"type":"ModelDeprecated",…
```

The same class was live for **400 `ModelProtocolUnsupported`**.

Rules going forward:

- **A status that means "this model is gone" is a MODEL error, not a
  transport failure.** 410 joins 404: `modelError: true,
  permanentModelError: true`. The combo skips to the next model; no account
  rotates and **no pool is parked**. A dead model must not take healthy
  siblings down with it.
- **A broad status must never be classified on the status alone.** 400 is the
  most generic failure there is (bad request, malformed tool-call JSON), so
  `ModelProtocolUnsupported` is matched on TEXT. A plain 400 must keep
  rotating — pinned in `tests/unit/error-config-permanent-model-error.test.js`
  (REQUEST_SCOPED).
- **A shared pool can only be parked by an error that is the POOL's fault**
  (402 dead relay, 429 quota, 5xx, suspend). A model-identity error is the
  MODEL's fault.
- **The all-failed verdict must name the real problem.** The combo's 429
  "All models quota-limited" now requires an actual quota signal; a
  body-level `retryAfter` on a non-quota failure no longer sets the
  earliest-retry clock, so a failure set where nothing was quota-limited is
  not reported as a quota problem.
- **Redundancy must span upstreams, not models.** A combo whose members all
  ride ONE upstream has no real redundancy: that upstream going down takes
  out the whole combo no matter how the error is classified. `9-free` gained
  backup members on OpenRouter and Antigravity for exactly this reason.
  Corollary for a client: a Hermes `fallback_providers` chain should point
  at independent upstreams too — `custom:888router` entries with different
  model prefixes only help if the models sit on different providers.
