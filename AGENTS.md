## Delivery rules (applies to EVERY agent/tool working in this repo)

These rules are tool-agnostic. Hermes, Claude Code, Codex, Grok, Agy, OpenCode
and any human contributor follow the same pipeline. Do not invent a shortcut
because your tool makes one convenient.

### Never hotfix a running container

The deployed workload runs a published image (`voravitl/888router:*`) on Kubernetes
(namespace `888router`) and does **not** mount this source tree. Editing files here
changes nothing — the bundled code in `/app/.next` inside running pods still holds
the old logic. Every change ships through the pipeline below.

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
   - **Crucial:** Version bump touches **3 Kubernetes files** alongside `package.json`:
     - `k8s/base/888router.yaml` (image tag)
     - `k8s/overlays/local/kustomization.yaml` (`images[].newTag`)
     - `k8s/overlays/prd/kustomization.yaml` (`images[].newTag`)
6. **Build image → redeploy (k8s) → verify (CRITICAL: ZERO-DOWNTIME FAST PATH).**
   - **Tag naming convention (CRITICAL):**
     Docker image tag in K8s is **WITHOUT `v`** (e.g. `voravitl/888router:0.15.120`), NEVER `v0.15.120`! Git tag has `v` (`v0.15.120`). A tag mismatch causes K8s to look for the wrong image and crash.
   - **MANDATORY local build BEFORE `kubectl apply`:**
     Because K8s deployment strategy is `Recreate` (due to SQLite single-writer PVC), K8s terminates the existing healthy pod FIRST before starting the new pod.
     If you run `kubectl apply` before the image exists locally, K8s attempts to pull from Docker Hub. But GitHub Actions takes 5-10 minutes to build and push, so Docker Hub returns 404!
     Result: New pod gets `ImagePullBackOff` / `ErrImagePull`, 0 replicas running, and Ingress returns **503 Service Unavailable** (OUTAGE!).
     **RULE:** Always build into local OrbStack Docker daemon FIRST:
     `docker build -t voravitl/888router:<version> -t voravitl/888router:latest .`
     OrbStack shares its local Docker daemon with K8s (`imagePullPolicy: IfNotPresent`). This starts the new pod in ~2 seconds without any external network pull.
   - **Deploy with Kustomize:**
     `kubectl apply -k k8s/overlays/local`
   - **Wait for rollout & verify live endpoint:**
     `kubectl rollout status deploy/888router -n 888router --timeout=120s`
     `curl http://router.k8s.orb.local/api/version`
     Must equal `package.json` version with HTTP 200. Pod in `Running` state alone is not enough.
   - **Emergency rollback (if pod fails):**
     If the pod crashes or hangs in `ImagePullBackOff`, IMMEDIATELY rollback:
     `kubectl rollout undo deploy/888router -n 888router`
   - **NEVER use `docker compose up`:**
     The active production service runs on **Kubernetes (`namespace: 888router`)**, NOT Docker Compose! Running docker compose does not deploy to K8s and breaks port mapping.
7. **Capture.** Record the lesson in the wiki/skill so the next agent does not
   repeat the mistake.

Nothing is "done" until `git log`, `/api/version` and the live Kubernetes deployment
all agree.

### Review is mandatory — the reviewer is not

Every code change gets an independent review from a model that did **not** write
it. Grok is the preferred first reviewer, but it is *not* a gate: if `grok` is
unavailable (missing binary, auth failure, non-zero exit, timeout, empty output,
`402` quota exhausted, `429`), **substitute the next reviewer of equal or higher
capability — never skip the review and never merge unreviewed.**

> **Current status:** `grok` is currently unavailable (`402` quota exhausted).
> **Active primary reviewer:** `9-opus` via 888router.

Fallback ladder (top preferred; descend until one returns real findings):

| Rank | Reviewer | How | Note |
|------|----------|-----|------|
| 1 | Grok 4.6 (`grok` CLI) | `cat /tmp/pr.diff \| grok -p "<review prompt>"` | *Quota exhausted (skip to Rank 2)* |
| 2 | `9-opus` via 888router | `python3 ~/.hermes/scripts/888router-review.py --model 9-opus --file /tmp/pr.diff` | **Active primary reviewer** |
| 3 | `cc/claude-opus-4-8` via 888router | same script, `--model cc/claude-opus-4-8` | |
| 4 | Claude Opus Thinking (`agy` CLI) | `cat /tmp/pr.diff \| agy -p "<review prompt>"` | |
| 5 | `codex` CLI | `codex exec "review this diff: ..."` | |
| 6 | `kr/claude-opus-4-8-thinking` via 888router | same script | |

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

### Docker entrypoint vs. hardened k8s securityContext (v0.15.99 → v0.15.100)

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
and `k8s/base` + both overlays still pinned `newTag: 0.15.99`. A later `kubectl apply -k`
re-pulled the poisoned `0.15.99` image and re-broke prod. Therefore:

- A code fix is **not shipped** until `package.json`/`package-lock.json`/`CHANGELOG` AND
  every k8s image reference (`k8s/base/888router.yaml` + `overlays/local` + `overlays/prd`)
  move to the new tag together. Grep `grep -rn 0.15.<old> k8s/ package.json` before calling
  it done.
- Treat a known-bad published tag as **burned**: supersede it with a new version, never try
  to "reuse"/overwrite it.
- Verify a privilege / securityContext change locally before deploying:
  `docker run --user 1000 --cap-drop ALL --security-opt no-new-privileges … <image>` must
  reach Ready, and the root path must end with PID 1 at uid 1000 (`cat /proc/1/status`).
- Fast incident mitigation is `kubectl rollout undo deploy -n 888router 888router
  --to-revision=<last-good>` (confirm the revision→image map first with
  `kubectl get rs -n 888router -o jsonpath` on the `deployment.kubernetes.io/revision`
  annotation).

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, invoke the `skill` tool with `skill: "graphify"` before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
