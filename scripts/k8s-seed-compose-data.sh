#!/usr/bin/env bash
set -euo pipefail

# Seed the compose instance's Docker volume from the Kubernetes PVC.
#
# This is the mirror image of k8s-migrate-data.sh (that one goes Docker -> K8s,
# this one goes K8s -> a Docker named volume). The k8s deployment stays online
# for the whole operation: node:sqlite backup() takes a transactionally
# consistent snapshot, exactly like the migrate script does in the other
# direction.
#
# WHY A COPY AND NOT A SHARED MOUNT
#   SQLite is single-writer. If the compose container and the k8s pod opened the
#   same database file, the two writers would interleave WAL frames and corrupt
#   it. The compose instance therefore owns a private volume seeded with a
#   point-in-time copy. Divergence after seeding is expected and one-way: the
#   clone does NOT sync back.
#
#   Re-seed to pull the k8s state across again. Re-seeding discards everything
#   written to the clone since, so it requires --force.
#
# WHAT IS COPIED
#   db/*.sqlite    transactionally consistent snapshot (PRAGMA integrity_check
#                  must pass before it is written to the volume)
#   auth/          CLI secret
#   mitm/          MITM proxy aliases
#   jwt-secret     keeps the session cookie valid across both instances
#   machine-id     keeps the machine identity stable across both instances
#
# WHAT IS NOT COPIED
#   db/backups/    ~200MB of historical upgrade snapshots — the clone regenerates
#                  its own on first upgrade
#   bin/           lazily downloaded helper binaries (cloudflared, tailscale);
#                  re-downloaded on first use
#   logs/          per-instance request logs
#
# USAGE
#   k8s-seed-compose-data.sh [--force] [--volume NAME]
#
#   --force           overwrite a volume that already holds data
#   --volume NAME     target volume (default: 888route-data)

NAMESPACE="888router"
DEPLOYMENT="888router"
POD_SELECTOR="app=888router"
DEFAULT_VOLUME="888route-data"
VOLUME="$DEFAULT_VOLUME"
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --volume) VOLUME="${2:?--volume needs a name}"; shift ;;
    --volume=*) VOLUME="${1#--volume=}" ;;
    -h | --help)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 1
      ;;
  esac
  shift
done

KUBE_CONTEXT="${KUBE_CONTEXT:-orbstack}"
HELPER_IMAGE="alpine:3.21"
# uid/gid of the `node` user inside the 888router image. The compose entrypoint
# runs as root and chowns /app/data, but pre-chowning here means the volume is
# correct even for a `docker run --user 1000` style invocation.
DATA_UID=1000
DATA_GID=1000

for command in docker kubectl node; do
  command -v "$command" >/dev/null || {
    echo "missing required command: $command" >&2
    exit 1
  }
done
if [ "$(kubectl config current-context)" != "$KUBE_CONTEXT" ]; then
  echo "refusing to seed: current Kubernetes context is not $KUBE_CONTEXT" >&2
  exit 1
fi

# Checked up front, before the ~30s snapshot work: `rm -rf /data/*` under a live
# SQLite writer is exactly the corruption this script exists to prevent, and
# --force must not be able to talk a user into it.
in_use=$(docker ps --filter "volume=$VOLUME" --format '{{.Names}}' | tr '\n' ' ')
if [ -n "${in_use// /}" ]; then
  echo "volume $VOLUME is still mounted by a running container: $in_use" >&2
  echo "stop it first:  docker compose stop 888route" >&2
  exit 1
fi

POD=$(kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get pod \
  -l "$POD_SELECTOR" \
  --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
if [ -z "$POD" ]; then
  echo "no Running pod matching $POD_SELECTOR in namespace $NAMESPACE" >&2
  exit 1
fi

STAGEDIR=$(mktemp -d)
cleanup() {
  kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" exec "$POD" -- \
    rm -rf /tmp/seed-stage /tmp/seed-aux.tgz >/dev/null 2>&1 || true
  rm -rf "$STAGEDIR"
}
trap cleanup EXIT INT TERM
mkdir -p "$STAGEDIR/db"

echo "==> Snapshotting SQLite from $NAMESPACE/$POD (deployment stays online)..."
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" exec "$POD" -- \
  sh -ceu 'rm -rf /tmp/seed-stage && mkdir -p /tmp/seed-stage'
# The node program is passed with -e, never on stdin: `kubectl exec` only
# forwards stdin when -i is passed, so a heredoc script would reach node as an
# empty program and exit 0 without writing anything. The result is checked below
# rather than trusted from the exit code.
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" exec "$POD" -- \
  node -e '
const { DatabaseSync, backup } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
backup(db, process.argv[2]).then(() => db.close()).catch((err) => {
  console.error(err);
  process.exit(1);
});
' /app/data/db/data.sqlite /tmp/seed-stage/data.sqlite
# `kubectl cp` exits 0 even when the source is missing (the underlying tar
# failure does not reach its exit code), so assert on the file itself.
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" exec "$POD" -- \
  test -s /tmp/seed-stage/data.sqlite
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" cp "$POD":/tmp/seed-stage/data.sqlite \
  "$STAGEDIR/db/data.sqlite" >/dev/null
[ -s "$STAGEDIR/db/data.sqlite" ] || {
  echo "kubectl cp did not produce a snapshot at $STAGEDIR/db/data.sqlite" >&2
  exit 1
}

echo "==> Copying identity + auth state..."
# auth/, mitm/, jwt-secret and machine-id are the state that makes the clone a
# drop-in twin: same machine id, same machine-id salt, same MITM aliases.
# ONE tar invocation, not a loop: piping several `tar cf -` streams together
# yields concatenated archives, and busybox tar inside the helper image only
# extracts the first one — the rest would silently vanish.
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" exec "$POD" -- sh -ceu '
  cd /app/data
  files=""
  for f in auth mitm jwt-secret machine-id; do
    [ -e "$f" ] && files="$files $f"
  done
  [ -n "$files" ] || exit 0
  tar czf /tmp/seed-aux.tgz $files
'
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" cp "$POD":/tmp/seed-aux.tgz \
  "$STAGEDIR/aux.tgz" >/dev/null
[ -s "$STAGEDIR/aux.tgz" ] || {
  echo "kubectl cp did not produce the aux archive at $STAGEDIR/aux.tgz" >&2
  exit 1
}
tar xzf "$STAGEDIR/aux.tgz" -C "$STAGEDIR"
# The staging archive must not follow the data into the volume.
rm -f "$STAGEDIR/aux.tgz"
for required in jwt-secret machine-id; do
  [ -e "$STAGEDIR/$required" ] || {
    echo "expected $required was not extracted from the pod — refusing to seed" >&2
    exit 1
  }
done

echo "==> Validating snapshot..."
result=$(node - "$STAGEDIR/db/data.sqlite" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
console.log(db.prepare('PRAGMA integrity_check').get().integrity_check);
db.close();
NODE
)
if [ "$result" != "ok" ]; then
  echo "integrity_check failed for the snapshot: $result" >&2
  exit 1
fi

echo "==> Preparing target volume $VOLUME..."
if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  docker volume create "$VOLUME" >/dev/null
  echo "    created empty volume $VOLUME"
else
  existing=$(docker run --rm -v "$VOLUME":/target "$HELPER_IMAGE" \
    sh -c 'find /target -mindepth 1 -maxdepth 1 | head -n 1' || true)
  if [ -n "$existing" ] && [ "$FORCE" -ne 1 ]; then
    echo "volume $VOLUME already contains data; re-seeding would discard it." >&2
    echo "re-run with --force if that is intended." >&2
    exit 1
  fi
  [ -n "$existing" ] && echo "    --force: overwriting existing contents of $VOLUME"
fi

echo "==> Writing snapshot into $VOLUME..."
docker run --rm \
  -v "$VOLUME":/data \
  -v "$STAGEDIR":/stage:ro \
  "$HELPER_IMAGE" sh -ceu '
    rm -rf /data/*
    mkdir -p /data/db
    cp -a /stage/. /data/
    # A stale -wal/-shm from the source pod would be replayed into the snapshot
    # on first open. The backup API already folded every committed WAL frame into
    # the snapshot, so the sidecars must not travel with it.
    rm -f /data/db/*.sqlite-wal /data/db/*.sqlite-shm /data/db/*.sqlite-journal
    chown -R '"$DATA_UID:$DATA_GID"' /data
    chmod 700 /data/db
    chmod 600 /data/db/*.sqlite
    # `if` rather than `[ -f x ] && chmod`: under `set -e` a false test in an
    # && chain aborts the whole script.
    for f in /data/jwt-secret /data/machine-id; do
      if [ -f "$f" ]; then chmod 600 "$f"; fi
    done
  '

docker run --rm -v "$VOLUME":/data "$HELPER_IMAGE" \
  sh -c 'du -sh /data | sed "s/^/    /"'

cat <<EOF

✅ Seeded volume $VOLUME from $NAMESPACE/$DEPLOYMENT.

   Next:
     scripts/k8s-sync-secret.sh --pull      # .env.route from the live Secret
     docker compose up -d 888route
     curl http://localhost:20129/api/version

   The clone is point-in-time and one-way: it does not sync back to k8s, and the
   two instances diverge from here. Re-run this script with --force to pull the
   k8s state across again (discarding changes made on the clone).
EOF
trap - EXIT INT TERM
cleanup
