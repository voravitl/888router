#!/usr/bin/env bash
set -euo pipefail

# Safely copy /app/data from Docker container to K8s pod PVC without stopping Docker
NAMESPACE="888router"
DOCKER_CONTAINER="${1:-888router}"

echo "==> Checking source Docker container ($DOCKER_CONTAINER)..."
if ! docker inspect "$DOCKER_CONTAINER" >/dev/null 2>&1; then
  echo "Error: Docker container $DOCKER_CONTAINER is not found or not running."
  exit 1
fi

echo "==> Finding target Kubernetes pod in namespace $NAMESPACE..."
POD=$(kubectl get pods -n "$NAMESPACE" -l app=888router -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)

if [[ -z "$POD" ]]; then
  echo "Error: No pod with label app=888router found in namespace $NAMESPACE."
  exit 1
fi

echo "==> Found K8s pod: $POD"
echo "==> Streaming live snapshot of /app/data from Docker to K8s Pod..."
docker exec "$DOCKER_CONTAINER" tar -czf - -C /app data | kubectl exec -i -n "$NAMESPACE" "$POD" -- tar -xzf - -C /app

echo "==> Verifying data on K8s pod..."
kubectl exec -n "$NAMESPACE" "$POD" -- ls -lh /app/data /app/data/db

echo "==> Restarting K8s deployment to ensure clean DB connection & lock refresh..."
kubectl rollout restart deployment/888router -n "$NAMESPACE"
kubectl rollout status deployment/888router -n "$NAMESPACE"

echo "✅ Migration completed successfully! K8s pod is running with cloned data."
