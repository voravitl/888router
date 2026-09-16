# Handoff — 888router 503 outage (su-exec / setgroups) → v0.15.100

**Date:** 2026-09-16 · **Cluster:** orbstack (local) · **Namespace:** `888router`
**Branch:** `fix/docker-suexec-dualmode-0.15.100` (off `master` @ `7bb1d1b2`)

## TL;DR for the next agent
The 503 was **not** DNS. The main pod was `CrashLoopBackOff` because image
`voravitl/888router:0.15.99` runs an entrypoint that calls `su-exec` unconditionally, and
`su-exec`'s `setgroups()` needs `CAP_SETGID` — which the hardened k8s `securityContext`
drops. Service was restored by rollback; the durable fix is a **dual-mode entrypoint** shipped
as **0.15.100**, already built and deployed to orbstack and verified. Remaining human/CI steps
are listed at the bottom (commit, and push the image for prd).

## Root cause
- Commit `8c51edab` ("fix(docker): use entrypoint to fix /app/data permissions") added an
  entrypoint doing `chown … && exec su-exec node "$@"`. Released as image `0.15.99`.
- k8s `securityContext`: `runAsNonRoot: true`, `runAsUser: 1000`, `capabilities.drop: [ALL]`,
  `allowPrivilegeEscalation: false`. `su-exec` → `setgroups()` → **EPERM** →
  `su-exec: setgroups: Operation not permitted` → exit 1 → `CrashLoopBackOff` → 0/1 backends →
  ingress **503**.
- HEAD (`7bb1d1b2`) had already removed su-exec in the Dockerfile, but the fix was **never
  versioned** (`package.json` stayed `0.15.99`) and `k8s/base` + both overlays still pinned
  `newTag: 0.15.99`. So `kubectl apply -k` / a redeploy kept re-pulling the poisoned tag
  (this was deployment revision 9 = the outage the user hit).

## What was done
1. **Incident mitigation (service restored):**
   `kubectl rollout undo deploy -n 888router 888router --to-revision=8` → known-good image
   `sha-7bb1d1b`, pod `1/1 Running`, ingress `router.k8s.orb.local/api/version` = **200**.
   (Revision→image map was confirmed first via the RS `deployment.kubernetes.io/revision`
   annotations; rev 8 = `sha-7bb1d1b`, rev 9 = broken `0.15.99`.)
2. **Long-term fix (v0.15.100)** on branch `fix/docker-suexec-dualmode-0.15.100`:
   - `docker-entrypoint.sh` (NEW): dual-mode su-exec/gosu pattern. Root → chown `/app/data*`
     + `exec su-exec node "$@"`; already non-root (k8s) → `exec "$@"` directly (never calls
     su-exec/setgroups).
   - `Dockerfile`: added `su-exec` to the runner apk line, removed `USER node` (plain Docker
     starts as root so the entrypoint can chown; k8s pins `runAsUser: 1000`), added
     `COPY --chmod=0755 docker-entrypoint.sh …` + `ENTRYPOINT`. `CMD ["node","custom-server.js"]`
     unchanged.
   - `package.json` + `package-lock.json`: `0.15.99` → `0.15.100` (lock via
     `npm install --package-lock-only`).
   - `k8s/base/888router.yaml` image + `overlays/local` + `overlays/prd` `newTag`:
     `0.15.99` → `0.15.100`.
   - `CHANGELOG.md`: prepended a `v0.15.100` entry.

## Verification (evidence)
- `docker build -t voravitl/888router:0.15.100 .` → success.
- **Hardened non-root (k8s-equivalent)** `docker run --user 1000 --cap-drop ALL --security-opt
  no-new-privileges …` → Next.js `✓ Ready`, **no setgroups error**, `/api/version` = 200,
  `currentVersion: 0.15.100`.
- **Root path** plain `docker run` → PID 1 `Uid: 1000` (dropped to node via su-exec), app Ready.
- **Live k8s** `kubectl set image` to `0.15.100` → pod `888router-54c85d65b7-*` `1/1 Running`,
  0 restarts; 6/6 `curl …/api/version` = **200** (one transient 503 only during the
  `Recreate` cutover, expected with `replicas: 1`). `kubectl kustomize k8s/overlays/local`
  renders `image: voravitl/888router:0.15.100`.
- **Tests:** `npx vitest run --config tests/vitest.config.js` → the only failures introduced by
  this change are the 4 `golden-url-header` snapshots that move with the version bump
  (refreshed with `-u`; touches only `tests/translator/__snapshots__/golden-url-header.test.js.snap`).
  The `db-sqlite-vs-lowdb` / `request-details-dba` failures are **pre-existing/environmental**
  (host `better-sqlite3` native binding is the wrong arch: `dlopen … slice is not valid mach-o
  file`); this branch changes **no** `.js/.ts` source, and the container rebuilds native deps so
  the running app's DB is fine.
- **Independent review:** grok (rank 1) hit its free usage limit; `9-opus` via 888router timed
  out and `cc/claude-opus-4-8` had no active creds; `agy` interrupted. Reviewed instead by two
  independent opus-tier reviewers (code-reviewer + security-reviewer) — **both APPROVED**, 0
  CRITICAL / 0 HIGH. Noted (informational): image now defaults to root (standard gosu/su-exec
  tradeoff); safe because every manifest pins `runAsUser: 1000` and `runAsNonRoot: true` is
  kubelet-enforced (fails closed).

## Current state
- Live cluster is serving **200** on `0.15.100` (deployed via `kubectl set image`).
- Branch `fix/docker-suexec-dualmode-0.15.100` holds all edits — **NOT committed yet**
  (awaiting the owner's go-ahead per git-safety).
- Unrelated WIP `k8s/base/networkpolicy.yaml` is modified in the working tree — **leave it
  alone / do not stage it** with this fix.

## Remaining steps (for the next agent / human / CI)
1. **Commit** the fix on the branch. Suggested split per the pipeline:
   - `fix(docker): dual-mode su-exec entrypoint; release 0.15.100; repin k8s to 0.15.100`
     (Dockerfile, docker-entrypoint.sh, package.json, package-lock.json, CHANGELOG.md, k8s/*).
   - `test(golden): refresh url-header snapshots for v0.15.100` (separate, labelled commit).
   - Do **not** stage `k8s/base/networkpolicy.yaml`.
2. **Publish for prd:** local orbstack uses the local image (`imagePullPolicy: IfNotPresent`),
   but production needs the tag in the registry. Push
   `voravitl/888router:0.15.100` (and the multi-arch build) to Docker Hub / GHCR before any
   prd rollout. The `0.15.99` tag is **burned** — never redeploy it.
3. **Do NOT `kubectl apply -k` the prd overlay** until its documented prerequisites
   (`BASE_URL`, TLS ingress, storage class) are set — see the note in
   `k8s/overlays/prd/kustomization.yaml`.

## Unrelated findings observed during triage (not fixed here)
- **DNS:** node `/etc/resolv.conf` has a single upstream `0.250.250.200` (OrbStack's host-DNS
  bridge) which **intermittently** times out (CoreDNS `forward . /etc/resolv.conf`), spamming
  `i/o timeout` for external names. Currently recovered (0 timeouts / 5 min; all lookups
  resolve). If it recurs, add a fallback upstream via a `coredns-custom` configmap or reset the
  host resolver (`orb restart` / VPN).
- **headroom** pod (`ghcr.io/chopratejas/headroom`) is `OOMKilled` on a loop (memory limit
  `1Gi`, loads an onnxruntime model). Bump its limit and/or relax the liveness probe.
- **metrics-server** is not installed → `kubectl top` unavailable.
