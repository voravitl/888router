#!/usr/bin/env bash
# Docker Cleanup — reclaim disk space on the 888router host
#
# Usage:
#   ./scripts/docker-cleanup.sh            # dry-run (report only)
#   ./scripts/docker-cleanup.sh --apply    # actually prune
#   ./scripts/docker-cleanup.sh --aggressive  # also prune unused volumes + old runner containers
#
# Safe defaults: never removes running containers or tagged images in use.

set -euo pipefail

DRY_RUN=true
AGGRESSIVE=false

for arg in "$@"; do
  case "$arg" in
    --apply) DRY_RUN=false ;;
    --aggressive) AGGRESSIVE=true ;;
  esac
done

info()  { printf "\033[36m%s\033[0m\n" "$*"; }
warn()  { printf "\033[33m%s\033[0m\n" "$*"; }
ok()    { printf "\033[32m%s\033[0m\n" "$*"; }
run() {
  if $DRY_RUN; then
    info "[DRY-RUN] $*"
  else
    info "[RUN] $*"
    "$@"
  fi
}

echo ""
info "============================================"
info "  Docker Cleanup — $(date '+%Y-%m-%d %H:%M')"
info "  Mode: $([ "$DRY_RUN" = true ] && echo 'DRY-RUN (report only)' || echo 'APPLY')"
info "============================================"
echo ""

# ── 1. System-level disk report ──
info "▶ Current disk usage:"
df -h / | tail -1
echo ""

info "▶ Docker disk summary:"
docker system df 2>/dev/null || true
echo ""

# ── 2. Remove dangling images (untagged <none>:<none>) ──
info "▶ Step 1: Remove dangling images"
DANGLING=$(docker images -f "dangling=true" -q 2>/dev/null | wc -l | tr -d ' ')
if [ "$DANGLING" -gt 0 ]; then
  warn "  Found $DANGLING dangling image(s)"
  run docker image prune -f
else
  ok "  No dangling images"
fi
echo ""

# ── 3. Remove stopped containers older than 7 days ──
info "▶ Step 2: Remove stopped containers >7 days old"
run docker container prune -f --filter "until=168h"
echo ""

# ── 4. Prune build cache ──
info "▶ Step 3: Prune Docker build cache"
run docker builder prune -f
echo ""

# ── 5. Aggressive: prune unused volumes + old runner containers ──
if [ "$AGGRESSIVE" = true ]; then
  info "▶ Step 4 (aggressive): Prune unused volumes"
  run docker volume prune -f
  echo ""

  info "▶ Step 5 (aggressive): Remove gh-runner-nonroot containers >14 days old"
  # gh-runner containers are ephemeral — safe to remove old ones; Docker will recreate on demand
  run docker container prune -f --filter "until=336h" --filter "name=gh-runner"
  echo ""

  info "▶ Step 6 (aggressive): Remove unused images (dangling + unreferenced)"
  run docker image prune -a -f
  echo ""
fi

# ── Summary ──
info "============================================"
info "  After cleanup:"
info "============================================"
df -h / | tail -1
echo ""
docker system df 2>/dev/null || true
echo ""

if $DRY_RUN; then
  warn "⚠  DRY-RUN — no changes made. Re-run with --apply to actually prune."
  warn "   Use --aggressive to also prune volumes + old runner containers."
fi
