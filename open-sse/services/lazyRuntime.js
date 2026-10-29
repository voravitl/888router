// Minimal runtime loader for optional dependencies that are BUNDLED into the
// image but not traced into the Next standalone build (wreq-js: loaded lazily,
// so file tracing never sees it — Dockerfile copies it into /app/node_modules).
//
// Deliberately smaller than upstream's lazyRuntime.js: no on-demand
// `npm install`, no writable data dir. A package that is not already installed
// is reported as missing and the caller decides how to degrade.
//
// Resolution order:
//   1. createRequire anchored at the app root (process.cwd()) — /app/node_modules
//      in the container, the repo node_modules in dev/tests;
//   2. a bundler-ignored dynamic import, resolved from this module's location.

// A static node:module import gets stubbed by the server bundler, so
// createRequire must be fetched at runtime for published builds to work.
let createRequirePromise;
function getCreateRequire() {
  createRequirePromise ??= import(/* webpackIgnore: true */ "node:module").then((mod) => mod.createRequire);
  return createRequirePromise;
}

async function load(pkg) {
  let firstError;
  try {
    const createRequire = await getCreateRequire();
    const appRequire = createRequire(`${process.cwd()}/package.json`);
    return appRequire(pkg);
  } catch (error) {
    firstError = error;
  }
  try {
    return await import(/* webpackIgnore: true */ pkg);
  } catch {
    throw firstError;
  }
}

const inflight = new Map();

/** Load an already-installed optional dependency; rejects when it is absent. */
export function loadRuntimeDep(pkg) {
  if (!inflight.has(pkg)) {
    inflight.set(pkg, load(pkg).finally(() => inflight.delete(pkg)));
  }
  return inflight.get(pkg);
}
