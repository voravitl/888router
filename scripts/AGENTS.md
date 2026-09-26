<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# scripts

## Purpose
Repo maintenance scripts: provider-registry migration, capability validation, release helpers, k8s data/secret sync, asset copying, and manual test harnesses.

## Key Files
| File | Description |
|------|-------------|
| `migrate-registry.mjs` | Regenerates `open-sse/providers/registry/index.js` (never hand-edit it) |
| `injectDisplayToRegistry.mjs` | Injects display metadata into registry |
| `validate-capabilities.mjs` | Validates capability tables |
| `cicd-release.sh` | Release automation |
| `k8s-migrate-data.sh` | K8s data migration |
| `k8s-sync-secret.sh` | K8s secret sync |
| `copy-standalone-assets.mjs` | Standalone build assets |
| `docker-cleanup.sh` | Docker prune helper |
| `generate_provider_logos.py` | Provider logo generation |
| `monkey-test.mjs` | Manual smoke harness |
| `test-combo-autoswitch.mjs` | Combo autoswitch manual test |
| `translate-readme.js` | README translation helper |

## For AI Agents

### Working In This Directory
- After adding `open-sse/providers/registry/{id}.js`, run `migrate-registry.mjs` — never hand-edit the generated index.
- Keep scripts dependency-light (node stdlib preferred); they run in CI and on fresh checkouts.

### Testing Requirements
- Script changes verified by running the script against a scratch copy before committing.

## Dependencies

### Internal
- `../open-sse/providers/registry/` — migration target
- `../tests/__baseline__/` — validation baselines

<!-- MANUAL: -->
