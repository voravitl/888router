## Delivery rules (applies to EVERY agent/tool working in this repo)

These rules are tool-agnostic. Hermes, Claude Code, Codex, Grok, Agy, OpenCode
and any human contributor follow the same pipeline. Do not invent a shortcut
because your tool makes one convenient.

### Never hotfix a running container

The deployed container runs a published image (`voravitl/888router:*`) and does
**not** mount this source tree. Editing files here and running
`docker compose restart` changes nothing — the bundled code in `/app/.next`
still holds the old logic. Every change ships through the pipeline below.

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
4. **Independent review.** See "Review is mandatory" below.
5. **Version + changelog.** Bump `package.json` **and** `package-lock.json`
   (regenerate via `npm install`, do not hand-edit the version strings) and add
   a `CHANGELOG.md` entry **before** tagging. Keep the changelog claim no
   broader than the diff actually is.
6. **Build image → redeploy → verify.** Rebuild, then
   `docker stop && docker rm && docker run` (a restart keeps the old image), and
   confirm with `curl http://localhost:20128/api/version`.
7. **Capture.** Record the lesson in the wiki/skill so the next agent does not
   repeat the mistake.

Nothing is "done" until `git log`, `/api/version` and the running compose stack
all agree.

### Review is mandatory — the reviewer is not

Every code change gets an independent review from a model that did **not** write
it. Grok is the preferred first reviewer, but it is *not* a gate: if `grok` is
unavailable (missing binary, auth failure, non-zero exit, timeout, empty output,
`402` quota exhausted, `429`), **substitute the next reviewer of equal or higher
capability — never skip the review and never merge unreviewed.**

Fallback ladder (top preferred; descend until one returns real findings):

| Rank | Reviewer | How |
|------|----------|-----|
| 1 | Grok 4.6 (`grok` CLI) | `cat /tmp/pr.diff \| grok -p "<review prompt>"` |
| 2 | `9-opus` via 888router | `python3 ~/.hermes/scripts/888router-review.py --model 9-opus --file /tmp/pr.diff` |
| 3 | `cc/claude-opus-4-8` via 888router | same script, `--model cc/claude-opus-4-8` |
| 4 | Claude Opus Thinking (`agy` CLI) | `cat /tmp/pr.diff \| agy -p "<review prompt>"` |
| 5 | `codex` CLI | `codex exec "review this diff: ..."` |
| 6 | `kr/claude-opus-4-8-thinking` via 888router | same script |

- **Equal or better only.** Never drop to a weaker/cheaper model just to get a
  faster green light. Opus/Grok tier is the floor.
- **Disclose substitutions.** Write it in the PR comment: "grok unavailable
  (402 quota exhausted) → reviewed by 9-opus instead." Silent substitution is a
  process violation.
- **Reviewer ≠ writer.** If the agent that wrote the diff is rank 1, drop to the
  next distinct reviewer.
- **Security/auth diffs need 3 reviewers** from the ladder, not 1.
- **No reviewer reachable → do not merge.** Report the blocker instead.
- Resolve every CRITICAL/HIGH finding before merge. Verify "missing wiring"
  findings against the full file first — reviewers only see the diff hunks and
  will false-positive on symbols already used in the base file.

### Capability-table edits (`open-sse/providers/capabilities.js`)

- Prefer explicit `vision: false` over omission when a model genuinely cannot
  accept images. Omission means "unspecified" and silently changes meaning if
  defaults ever change.
- Fix the **whole family**, not one model ID. Grep every occurrence and alias
  before claiming family-level scope in the changelog.
- Structural fix over per-model patch: if new models of the same family will
  keep hitting the bug, fix the resolution mechanism instead of enumerating IDs.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, invoke the `skill` tool with `skill: "graphify"` before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
