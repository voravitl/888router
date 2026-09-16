#!/bin/sh
set -e

# Dual-mode privilege handling (gosu/su-exec pattern, as used by the official
# postgres/redis/node images). See Dockerfile for the full rationale.
#
#   * Started as root (plain `docker run`, possibly with a root-owned bind mount):
#     fix ownership of the data dirs, then drop to the unprivileged `node` user.
#
#   * Started already non-root (Kubernetes runAsUser=1000 + drop ALL capabilities):
#     su-exec would call setgroups(), which needs CAP_SETGID. Under a hardened
#     securityContext that capability is dropped, so setgroups() returns EPERM and
#     the container crash-loops. This exact regression shipped in image 0.15.99
#     ("su-exec: setgroups: Operation not permitted" -> CrashLoopBackOff -> 503).
#     When we are already the target user there is nothing to drop, so exec directly.
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/data /app/data-home 2>/dev/null || true
  exec su-exec node "$@"
fi

# ponytail: the non-root path trusts k8s fsGroup / Docker named-volume ownership for
# /app/data writability. Known ceiling: a root-owned *bind mount* entered under a
# non-root UID stays unwritable (upgrade path: start once as root so the branch above
# chowns it, or pre-chown the host directory to uid 1000).
exec "$@"
