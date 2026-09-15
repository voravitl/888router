#!/usr/bin/env bash
set -euo pipefail

# Generate and apply K8s secret from local .env without saving secret files to disk.
# Fails closed: any missing, empty, or placeholder value aborts without touching
# the existing Secret. Only ever targets the orbstack context.
ENV_FILE="${1:-.env}"
NAMESPACE="888router"
KUBE_CONTEXT="${KUBE_CONTEXT:-orbstack}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found."
  exit 1
fi

if [ "$(kubectl config current-context)" != "$KUBE_CONTEXT" ]; then
  echo "Error: refusing to sync secrets — current Kubernetes context is not $KUBE_CONTEXT."
  exit 1
fi

# Strict dotenv parse: LAST occurrence wins, supports `export KEY=`, spaces
# around `=`, single/double quotes, and strips inline comments outside quotes.
dotenv_get() {
  local key="$1" line val
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$ENV_FILE" | tail -n 1 || true)
  if [ -z "$line" ]; then
    echo ""
    return
  fi
  val=${line#*=}
  val=$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  case "$val" in
    \"*\") val=${val#\"}; val=${val%\"} ;;
    \'*\') val=${val#\'}; val=${val%\'} ;;
    *) val=$(printf '%s' "$val" | sed -e 's/[[:space:]]*#.*$//') ;;
  esac
  printf '%s' "$val"
}

JWT_SECRET=$(dotenv_get JWT_SECRET)
API_KEY_SECRET=$(dotenv_get API_KEY_SECRET)
INITIAL_PASSWORD=$(dotenv_get INITIAL_PASSWORD)
MACHINE_ID_SALT=$(dotenv_get MACHINE_ID_SALT)
SEARXNG_SECRET=$(dotenv_get SEARXNG_SECRET)

invalid=0
for kv in "JWT_SECRET:$JWT_SECRET" "API_KEY_SECRET:$API_KEY_SECRET" "INITIAL_PASSWORD:$INITIAL_PASSWORD" "MACHINE_ID_SALT:$MACHINE_ID_SALT" "SEARXNG_SECRET:$SEARXNG_SECRET"; do
  key=${kv%%:*}
  val=${kv#*:}
  case "$val" in
    ""|*"change-me"*|*"placeholder"*|*"example"*|123456|password|secret)
      echo "Error: $key is missing, empty, or a placeholder — refusing to overwrite the existing Secret."
      invalid=1
      ;;
  esac
done
if [ "$invalid" -ne 0 ]; then
  exit 1
fi

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply --context="$KUBE_CONTEXT" -f -

kubectl create secret generic 888router-secrets \
  --namespace="$NAMESPACE" \
  --from-literal=JWT_SECRET="${JWT_SECRET}" \
  --from-literal=API_KEY_SECRET="${API_KEY_SECRET}" \
  --from-literal=INITIAL_PASSWORD="${INITIAL_PASSWORD}" \
  --from-literal=MACHINE_ID_SALT="${MACHINE_ID_SALT}" \
  --from-literal=SEARXNG_SECRET="${SEARXNG_SECRET}" \
  --dry-run=client -o yaml | kubectl apply --context="$KUBE_CONTEXT" -f -

echo "✅ Secret 888router-secrets successfully synced to namespace $NAMESPACE."
