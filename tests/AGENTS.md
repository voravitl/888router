<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# tests

## Purpose
Independent vitest ESM package (not wired into root `npm test`): unit, translator, auth, and integration suites plus regression baselines. `*.real.test.js` needs live provider credentials; everything else runs offline with mocks.

## Key Files
| File | Description |
|------|-------------|
| `vitest.config.js` | Vitest config (resolves `open-sse`/`@/` aliases from repo root) |
| `package.json` | Test-only deps (vitest); ignore its `test` script (hardcoded Unix paths) |
| `README.md` | Suite usage notes |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `unit/` | Unit tests per feature (largest suite) |
| `translator/` | Translation-layer tests, data-driven per provider (see `translator/AGENTS.md`) |
| `auth/` | Auth/session tests |
| `integration/` | Multi-component integration tests |
| `__baseline__/` | Regression baselines: `verify-no-regression.mjs`, `known-fails.txt`, snapshots |

## For AI Agents

### Working In This Directory
- ALWAYS run from the repo root: `npx vitest run --config tests/vitest.config.js` (running from `tests/` breaks `path.resolve("src/...")` suites).
- Single file: `npx vitest run unit/<name>.test.js` with paths relative to `tests/`.
- Suite is not all-green on plain checkout (~64 known fails); judge regressions with `tests/__baseline__/verify-no-regression.mjs`, not a raw run.
- `unit/xai-oauth-service.test.js` times out without network; `real/*.real.test.js` needs credentials — skip otherwise.

### Testing Requirements
- Every code change ships with a test here; version bumps that move `golden-url-header` snapshots get a separate `-u` refresh commit.

## Dependencies

### Internal
- `../src/` (via `@/` alias), `../open-sse/`

### External
- vitest (in `tests/node_modules`, allowed by `tests/.gitignore`)

<!-- MANUAL: -->
