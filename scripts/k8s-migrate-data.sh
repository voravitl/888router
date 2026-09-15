#!/usr/bin/env bash
set -euo pipefail

# Migrate /app/data from Docker container to K8s PVC with a SQLite-consistent
# snapshot. The target deployment is scaled to zero first so no writer holds
# the destination DB, and the source uses `sqlite3 .backup` (not tar of live
# files) to avoid capturing DB/WAL at different points in time.
NAMESPACE="888router"
DEPLOYMENT="888router"
DOCKER_CONTAINER="${1:-888router}"

echo "==> Checking source Docker container ($DOCKER_CONTAINER)..."
if ! docker inspect "$DOCKER_CONTAINER" >/dev/null 2>&1; then
  echo "Error: Docker container $DOCKER_CONTAINER is not found or not running."
  exit 1
fi

echo "==> Finding target Kubernetes pod in namespace $NAMESPACE..."
if ! kubectl get deployment -n "$NAMESPACE" "$DEPLOYMENT" >/dev/null 2>&1; then
  echo "Error: deployment/$DEPLOYMENT not found in namespace $NAMESPACE."
  exit 1
fi

STAGEDIR=$(mktemp -d)
trap 'rm -rf "$STAGEDIR"' EXIT

echo "==> Creating SQLite-consistent backup of source databases..."
mkdir -p "$STAGEDIR/data/db"
for db in $(docker exec "$DOCKER_CONTAINER" sh -c 'ls /app/data/db/*.sqlite 2>/dev/null' || true); do
  base=$(basename "$db")
  echo "    backing up $base..."
  docker exec "$DOCKER_CONTAINER" sqlite3 "$db" ".backup '/tmp/migrate-$base'" || {
    echo "Error: sqlite3 backup of $db failed (is sqlite3 installed in the container?)."
    exit 1
  }
  docker cp "$DOCKER_CONTAINER:/tmp/migrate-$base" "$STAGEDIR/data/db/$base"
  docker exec "$DOCKER_CONTAINER" rm -f "/tmp/migrate-$base"
done

if [ -z "$(ls -A "$STAGEDIR/data/db" 2>/dev/null)" ]; then
  echo "Error: no SQLite databases found under /app/data/db in $DOCKER_CONTAINER."
  exit 1
fi

echo "==> Validating backup integrity..."
for db in "$STAGEDIR/data/db"/*.sqlite; do
  result=$(sqlite3 "$db" "PRAGMA integrity_check;" 2>&1) || {
    echo "Error: integrity check failed for $(basename "$db"): $result"
    exit 1
  }
  if [ "$result" != "ok" ]; then
    echo "Error: integrity check failed for $(basename "$db"): $result"
    exit 1
  fi
done

echo "==> Scaling target deployment to zero (quiesce writers)..."
kubectl scale deployment -n "$NAMESPACE" "$DEPLOYMENT" --replicas=0
kubectl rollout status deployment -n "$NAMESPACE" "$DEPLOYMENT" --timeout=120s

RESTORE_POD=""
restore_cleanup() {
  if [ -n "$RESTORE_POD" ]; then
    kubectl delete pod -n "$NAMESPACE" "$RESTORE_POD" --ignore-not-found >/dev/null 2>&1 || true
  fi
}
trap 'restore_cleanup; rm -rf "$STAGEDIR"' EXIT

echo "==> Starting one-shot restore pod mounting the PVC..."
RESTORE_POD="migrate-restore-$(date +%s)"
kubectl run -n "$NAMESPACE" "$RESTORE_POD" --restart=Never \
  --image=alpine:3.21 --command -- sleep 600 >/dev/null
kubectl wait -n "$NAMESPACE" --for=condition=Ready "pod/$RESTORE_POD" --timeout=120s >/dev/null

echo "==> Replacing destination DB files with validated backup..."
kubectl cp "$STAGEDIR/data/db" "$NAMESPACE/$RESTORE_POD:/app-data-staging" >/dev/null
kubectl exec -n "$NAMESPACE" "$RESTORE_POD" -- sh -c \
  'rm -f /app/data/db/*.sqlite /app/data/db/*.sqlite-wal /app/data/db/*.sqlite-shm /app/data/db/*.sqlite-journal && cp /app-data-staging/*.sqlite /app/data/db/ && ls -lh /app/data/db'

echo "==> Scaling target deployment back to 1..."
kubectl scale deployment -n "$NAMESPACE" "$DEPLOYMENT" --replicas=1
kubectl rollout status deployment -n "$NAMESPACE" "$DEPLOYMENT" --timeout=300s

restore_cleanup
trap 'rm -rf "$STAGEDIR"' EXIT

echo "✅ Migration completed successfully! K8s deployment is running with migrated data."
echo "NOTE: this procedure stops the K8s target during migration (not zero-downtime);"
echo "Docker source keeps running but its writes during backup are not included."
