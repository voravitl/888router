#!/usr/bin/env bash
set -euo pipefail

# Migrate /app/data SQLite databases from Docker to the Kubernetes PVC.
# Source snapshot uses node:sqlite backup() for a transactionally consistent
# copy while Docker stays online. Target is scaled to zero during restore.
NAMESPACE="888router"
DEPLOYMENT="888router"
PVC="888router-data-pvc"
DOCKER_CONTAINER="${1:-888router}"
KUBE_CONTEXT="${KUBE_CONTEXT:-orbstack}"

for command in docker kubectl node; do
  command -v "$command" >/dev/null || { echo "missing required command: $command" >&2; exit 1; }
done
if [ "$(kubectl config current-context)" != "$KUBE_CONTEXT" ]; then
  echo "refusing migration: current Kubernetes context is not $KUBE_CONTEXT" >&2
  exit 1
fi
if ! docker inspect "$DOCKER_CONTAINER" >/dev/null 2>&1; then
  echo "source Docker container $DOCKER_CONTAINER is not running" >&2
  exit 1
fi
if ! kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get deployment "$DEPLOYMENT" >/dev/null 2>&1; then
  echo "deployment/$DEPLOYMENT not found in namespace $NAMESPACE" >&2
  exit 1
fi

STAGEDIR=$(mktemp -d)
RESTORE_POD="migrate-restore-$(date +%s)"
SCALED_DOWN=0
cleanup() {
  kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" delete pod "$RESTORE_POD" --ignore-not-found >/dev/null 2>&1 || true
  if [ "$SCALED_DOWN" -eq 1 ]; then
    kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" scale deployment "$DEPLOYMENT" --replicas=1 >/dev/null 2>&1 || true
    kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" rollout status deployment "$DEPLOYMENT" --timeout=300s >/dev/null 2>&1 || true
  fi
  rm -rf "$STAGEDIR"
}
trap cleanup EXIT INT TERM
mkdir -p "$STAGEDIR/db"

echo "==> Creating SQLite-consistent source snapshots..."
DBS=$(docker exec "$DOCKER_CONTAINER" sh -c 'ls /app/data/db/*.sqlite 2>/dev/null' || true)
[ -n "$DBS" ] || { echo "no SQLite databases found in /app/data/db" >&2; exit 1; }
for db in $DBS; do
  base=$(basename "$db")
  docker exec "$DOCKER_CONTAINER" node - "$db" "/tmp/migrate-$base" <<'NODE'
const { DatabaseSync, backup } = require('node:sqlite');
const source = process.argv[2];
const destination = process.argv[3];
const db = new DatabaseSync(source, { readOnly: true });
backup(db, destination).then(() => db.close()).catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE
  docker cp "$DOCKER_CONTAINER:/tmp/migrate-$base" "$STAGEDIR/db/$base" >/dev/null
  docker exec "$DOCKER_CONTAINER" rm -f "/tmp/migrate-$base"
done

echo "==> Validating source snapshots..."
for db in "$STAGEDIR"/db/*.sqlite; do
  result=$(node - "$db" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
console.log(db.prepare('PRAGMA integrity_check').get().integrity_check);
db.close();
NODE
)
  [ "$result" = "ok" ] || { echo "integrity_check failed for $db: $result" >&2; exit 1; }
done

echo "==> Quiescing Kubernetes writer..."
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" scale deployment "$DEPLOYMENT" --replicas=0
SCALED_DOWN=1
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" wait --for=delete pod -l app=888router --timeout=180s || true

cat <<EOF | kubectl --context "$KUBE_CONTEXT" apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: $RESTORE_POD
  namespace: $NAMESPACE
spec:
  restartPolicy: Never
  containers:
    - name: restore
      image: alpine:3.21
      command: ["/bin/sh", "-c", "sleep 600"]
      volumeMounts:
        - name: data
          mountPath: /app/data
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: $PVC
EOF
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" wait --for=condition=Ready "pod/$RESTORE_POD" --timeout=120s >/dev/null

kubectl --context "$KUBE_CONTEXT" cp "$STAGEDIR/db" "$NAMESPACE/$RESTORE_POD:/tmp/migrated-db" >/dev/null
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" exec "$RESTORE_POD" -- sh -ceu '
  mkdir -p /app/data/db
  rm -f /app/data/db/*.sqlite /app/data/db/*.sqlite-wal /app/data/db/*.sqlite-shm /app/data/db/*.sqlite-journal
  cp /tmp/migrated-db/*.sqlite /app/data/db/
  chown -R 1000:1000 /app/data/db
  chmod 700 /app/data/db
  chmod 600 /app/data/db/*.sqlite
  ls -lh /app/data/db
'

kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" delete pod "$RESTORE_POD" --wait=true >/dev/null
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" scale deployment "$DEPLOYMENT" --replicas=1
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" rollout status deployment "$DEPLOYMENT" --timeout=300s
SCALED_DOWN=0
trap - EXIT INT TERM
rm -rf "$STAGEDIR"
echo "✅ SQLite-consistent migration completed; source Docker stayed online, K8s target was briefly stopped."
