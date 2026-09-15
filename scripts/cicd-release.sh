#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-$(node -e 'console.log(require("./package.json").version)')}"
KUBE_CONTEXT="${KUBE_CONTEXT:-orbstack}"
OVERLAY="${KUSTOMIZE_OVERLAY:-k8s/overlays/local}"
IMAGE="voravitl/888router:${VERSION}"

for command in kubectl kustomize curl node; do
  command -v "$command" >/dev/null || {
    echo "missing required command: $command" >&2
    exit 1
  }
done

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

kubectl --context "$KUBE_CONTEXT" apply -k "$overlay"

# Pre-deploy availability snapshot: fail closed if fewer than 2 ready pods
# exist before the rollout (rolling update with maxUnavailable=0 needs quorum).
ready_before=$(kubectl --context "$KUBE_CONTEXT" -n 888router get deployment/888router \
  -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
if [ "${ready_before:-0}" -lt 2 ]; then
  echo "refusing to deploy: only ${ready_before:-0} ready replica(s), need >= 2 for zero-downtime rollout" >&2
  exit 1
fi

kubectl --context "$KUBE_CONTEXT" -n 888router rollout status deployment/888router --timeout=300s
kubectl --context "$KUBE_CONTEXT" -n 888router get deployment/888router \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="888router")].image}' | grep -Fx "$IMAGE" >/dev/null

# Post-deploy availability gate: version endpoint must stay reachable
# throughout and after the rollout (catches bad image that passes probes).
curl --fail --show-error --retry 12 --retry-all-errors --retry-delay 2 \
  https://888router.k8s.orb.local/api/version
