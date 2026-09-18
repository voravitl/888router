#!/usr/bin/env bash
set -euo pipefail

# Local Kustomize deploy (NOT a full release: image must already be published).
# Usage: ./scripts/cicd-release.sh <version>   (e.g. ./scripts/cicd-release.sh 0.15.99)
# Deploys voravitl/888router:<version> to the local OrbStack overlay with:
#   - server-side dry-run validation before any mutation
#   - bootstrap/update split: fresh installs apply+wait; updates require the
#     existing Deployment to be fully stable BEFORE apply (fail closed)
#   - automatic rollback to the previous ReplicaSet on rollout/version failure
#   - version comparison (endpoint must report the deployed version)
#
# OUTAGE DISCIPLINE (single-replica Recreate + SQLite RWO single-writer means
# EVERY rollout has a downtime gap): push-to-master ALSO auto-deploys via the
# docker-publish.yml deploy-local-kubernetes job. Running this script and then
# pushing therefore causes TWO outages back-to-back. Pick exactly one path per
# release: prefer push → CI auto-deploy; use this script only when the change
# will not be pushed (or accept the second rollout).
VERSION="${1:-$(node -e 'console.log(require("./package.json").version)')}"
IMAGE_TAG="${IMAGE_TAG:-$VERSION}"
KUBE_CONTEXT="${KUBE_CONTEXT:-orbstack}"
OVERLAY="${KUSTOMIZE_OVERLAY:-k8s/overlays/local}"
IMAGE="voravitl/888router:${IMAGE_TAG}"

for command in kubectl kustomize curl node jq; do
  command -v "$command" >/dev/null || {
    echo "missing required command: $command" >&2
    exit 1
  }
done

# Warn (never block CI) when this manual deploy will be followed by a second
# auto-deploy: local commits ahead of origin/master get pushed later, and that
# push re-rolls the single-replica Recreate deployment (second outage gap).
if [ -z "${CICD_SKIP_DOUBLE_DEPLOY_CHECK:-}" ]; then
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    ahead=$(git rev-list --count "origin/master..HEAD" 2>/dev/null || echo 0)
    case "${ahead:-0}" in
      ''|*[!0-9]*) ahead=0 ;;
    esac
    if [ "$ahead" -gt 0 ]; then
      echo "warning: branch is ${ahead} commit(s) ahead of origin/master;" >&2
      echo "warning: a later push triggers CI auto-deploy = SECOND outage gap (Recreate)." >&2
      echo "warning: prefer one path per release (push→CI) or set CICD_SKIP_DOUBLE_DEPLOY_CHECK=1." >&2
    fi
  fi
fi

if [ "$(kubectl config current-context)" != "$KUBE_CONTEXT" ]; then
  echo "refusing to deploy: current Kubernetes context is not $KUBE_CONTEXT" >&2
  exit 1
fi

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
cp -R k8s "$workdir/k8s"
overlay="$workdir/$OVERLAY"

kubectl kustomize "$overlay" >/dev/null
(
  cd "$overlay"
  kustomize edit set image "voravitl/888router=$IMAGE"
)

rendered=$(kubectl kustomize "$overlay")
printf '%s\n' "$rendered" | grep -F "image: $IMAGE" >/dev/null || {
  echo "rendered manifest does not use $IMAGE" >&2
  exit 1
}

# Server-side dry-run before any mutation (admission/schema/storage failures
# surface here without starting a rollout).
kubectl --context "$KUBE_CONTEXT" apply --dry-run=server -k "$overlay" >/dev/null

# Bootstrap vs update: a fresh install has no Deployment yet — apply and wait.
# An existing Deployment must be fully stable BEFORE we mutate it.
if ! kubectl --context "$KUBE_CONTEXT" -n 888router get deployment/888router >/dev/null 2>&1; then
  echo "bootstrap: no existing deployment, applying and waiting..."
  kubectl --context "$KUBE_CONTEXT" apply -k "$overlay"
  kubectl --context "$KUBE_CONTEXT" -n 888router rollout status deployment/888router --timeout=300s
else
  stable=$(kubectl --context "$KUBE_CONTEXT" -n 888router get deployment/888router -o json)
  check() { printf '%s' "$stable" | jq -e "$1" >/dev/null; }
  stable_ok=1
  check '.status.observedGeneration == .metadata.generation' || stable_ok=0
  check '.status.updatedReplicas == .spec.replicas' || stable_ok=0
  check '.status.readyReplicas == .spec.replicas' || stable_ok=0
  check '.status.availableReplicas == .spec.replicas' || stable_ok=0
  check '(.status.unavailableReplicas // 0) == 0' || stable_ok=0
  if [ "$stable_ok" -ne 1 ]; then
    echo "refusing to deploy: existing deployment is not fully stable (in-progress rollout or degraded)" >&2
    kubectl --context "$KUBE_CONTEXT" -n 888router rollout status deployment/888router --timeout=30s || true
    exit 1
  fi

  prev_image=$(kubectl --context "$KUBE_CONTEXT" -n 888router get deployment/888router \
    -o jsonpath='{.spec.template.spec.containers[?(@.name=="888router")].image}')
  prev_revision=$(kubectl --context "$KUBE_CONTEXT" -n 888router rollout history deployment/888router \
    -o jsonpath='{.metadata.generation}' 2>/dev/null || echo unknown)

  kubectl --context "$KUBE_CONTEXT" apply -k "$overlay"

  rollback() {
    echo "deploy failed — rolling back to previous ReplicaSet (was $prev_image, revision $prev_revision)..." >&2
    kubectl --context "$KUBE_CONTEXT" -n 888router rollout undo deployment/888router || true
    kubectl --context "$KUBE_CONTEXT" -n 888router rollout status deployment/888router --timeout=300s || true
    echo "--- failure diagnostics ---" >&2
    kubectl --context "$KUBE_CONTEXT" -n 888router describe deployment/888router >&2 || true
    kubectl --context "$KUBE_CONTEXT" -n 888router get pods -l app=888router >&2 || true
    kubectl --context "$KUBE_CONTEXT" -n 888router logs -l app=888router --tail=100 >&2 || true
  }

  if ! kubectl --context "$KUBE_CONTEXT" -n 888router rollout status deployment/888router --timeout=300s; then
    rollback
    exit 1
  fi
  if ! kubectl --context "$KUBE_CONTEXT" -n 888router get deployment/888router \
    -o jsonpath='{.spec.template.spec.containers[?(@.name=="888router")].image}' | grep -Fx "$IMAGE" >/dev/null; then
    echo "deployed image does not match $IMAGE" >&2
    rollback
    exit 1
  fi
fi

# Version gate: the endpoint must report the deployed version, not just HTTP 200.
reported=$(curl --fail --show-error --retry 12 --retry-all-errors --retry-delay 2 \
  https://888router.k8s.orb.local/api/version | jq -r '.currentVersion')
if [ "$reported" != "$VERSION" ]; then
  echo "version mismatch: endpoint reports $reported, expected $VERSION" >&2
  if kubectl --context "$KUBE_CONTEXT" -n 888router get deployment/888router >/dev/null 2>&1; then
    kubectl --context "$KUBE_CONTEXT" -n 888router rollout undo deployment/888router || true
    kubectl --context "$KUBE_CONTEXT" -n 888router rollout status deployment/888router --timeout=300s || true
  fi
  exit 1
fi

echo "✅ Deployed $IMAGE, endpoint reports version $reported"
