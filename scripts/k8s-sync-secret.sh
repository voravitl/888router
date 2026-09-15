#!/usr/bin/env bash
set -euo pipefail

# Generate and apply K8s secret from local .env without saving secret files to disk
ENV_FILE="${1:-.env}"
NAMESPACE="888router"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found."
  exit 1
fi

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

# Extract key secrets from .env
JWT_SECRET=$(grep -E '^JWT_SECRET=' "$ENV_FILE" | cut -d '=' -f2- || true)
API_KEY_SECRET=$(grep -E '^API_KEY_SECRET=' "$ENV_FILE" | cut -d '=' -f2- || true)
INITIAL_PASSWORD=$(grep -E '^INITIAL_PASSWORD=' "$ENV_FILE" | cut -d '=' -f2- || true)
MACHINE_ID_SALT=$(grep -E '^MACHINE_ID_SALT=' "$ENV_FILE" | cut -d '=' -f2- || true)
SEARXNG_SECRET=$(grep -E '^SEARXNG_SECRET=' "$ENV_FILE" | cut -d '=' -f2- || true)

kubectl create secret generic 888router-secrets \
  --namespace="$NAMESPACE" \
  --from-literal=JWT_SECRET="${JWT_SECRET}" \
  --from-literal=API_KEY_SECRET="${API_KEY_SECRET}" \
  --from-literal=INITIAL_PASSWORD="${INITIAL_PASSWORD}" \
  --from-literal=MACHINE_ID_SALT="${MACHINE_ID_SALT}" \
  --from-literal=SEARXNG_SECRET="${SEARXNG_SECRET}" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "✅ Secret 888router-secrets successfully synced to namespace $NAMESPACE."
