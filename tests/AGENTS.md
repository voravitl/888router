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
- In CI, invoke the PINNED binary explicitly: `./tests/node_modules/.bin/vitest run --config tests/vitest.config.js`. Plain `npx vitest` from the repo root does not find the pinned vitest (it lives in `tests/node_modules`) and silently fetches a different major from the registry — verified: npx resolved 5.0.5 against the pinned 4.1.10.
- Suite is all-green as of 2026-10-21 (full run: 3,615 passed / 1
  deliberate `test.fails` case / 0 failed) and `known-fails.txt` is EMPTY by
  policy — see the header of `tests/__baseline__/known-fails.txt` for when to
  re-add an entry. Judge regressions with `tests/__baseline__/verify-no-regression.mjs`
  against that file, not a raw run; never re-fill it with passing tests.
- The FULL suite is the CI gate (ci.yml and docker-publish.yml both run it
  from the repo root, plus `verify-no-regression.mjs`). There is no smoke
  subset any more — a new test file is covered the moment it lands, so there
  is no list to remember to update.
- The suite must pass on ANY machine, not just the maintainer's. Snapshot
  files must never record the host's identity (`process.platform`,
  `process.arch`, `process.version`, `os.hostname()`, a path) — see
  `translator/golden-url-header.sanitize.mjs` and the guard test in
  `translator/golden-url-header.test.js` that compares a real host run
  against a canary run. A test must assert the unit's behaviour, not the
  ambient environment (an assertion like `toBeUndefined()` on a variable the
  parent process may export tests the parent, not the unit).
- `unit/xai-oauth-service.test.js` times out without network; `real/*.real.test.js` needs credentials — skip otherwise.

### Testing Requirements
- Every code change ships with a test here; version bumps that move `golden-url-header` snapshots get a separate `-u` refresh commit.

## Dependencies

### Internal
- `../src/` (via `@/` alias), `../open-sse/`

### External
- vitest (in `tests/node_modules`, allowed by `tests/.gitignore`)

<!-- MANUAL: -->
