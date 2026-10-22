import { describe, it, expect } from "vitest";

// The release-bump rule: a change to shipped code must move the version, and
// the changelog and the lockfile must agree with it. Without this, a merged
// fix ships an image whose code moved but whose /api/version did not
// (lesson #503, merged at 0.15.141 with new code).
import {
  evaluateReleaseBump,
  isRuntimePath,
  parseChangelogTopVersion,
  compareSemver,
} from "../../scripts/check-release-bump.mjs";

describe("which paths need a version bump", () => {
  it("counts shipped code as needing a bump", () => {
    for (const p of [
      "open-sse/rtk/systemInject.js",
      "src/app/page.js",
      "skills/ponytail-review/SKILL.md", // the gateway SERVES these
      "skills/README.md", // ships with the served skills
      "package.json",
      "package-lock.json",
      "public/logo.svg",
      "cli/scripts/hud.js",
    ]) {
      expect(isRuntimePath(p), p).toBe(true);
    }
  });

  it("does not count docs, tests, CI config or repo scripts", () => {
    for (const p of [
      "README.md",
      "CHANGELOG.md",
      "AGENTS.md",
      "tests/unit/foo.test.js",
      "docs/architecture.md",
      "gitbook/README.md",
      ".github/workflows/ci.yml",
      "scripts/check-release-bump.mjs",
      "k8s/base/888router.yaml",
    ]) {
      expect(isRuntimePath(p), p).toBe(false);
    }
  });
});

describe("changelog version heading", () => {
  it("reads the version at the top", () => {
    expect(parseChangelogTopVersion("# v0.15.184 (2026-10-22)\n\ntext")).toBe("0.15.184");
    expect(parseChangelogTopVersion("# 0.15.184\n")).toBe("0.15.184");
  });

  it("returns null when there is no version heading", () => {
    expect(parseChangelogTopVersion("# Changelog\n\nnotes")).toBeNull();
    expect(parseChangelogTopVersion("")).toBeNull();
  });
});

describe("semver comparison", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareSemver("0.15.184", "0.15.183")).toBeGreaterThan(0);
    expect(compareSemver("0.16.0", "0.15.999")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareSemver("0.15.184", "0.15.184")).toBe(0);
    expect(compareSemver("0.15.183", "0.15.184")).toBeLessThan(0);
  });
});

describe("release bump rule", () => {
  const good = {
    baseVersion: "0.15.184",
    headVersion: "0.15.185",
    lockVersion: "0.15.185",
    changelogTopVersion: "0.15.185",
  };

  it("passes a docs-only change without any bump", () => {
    const r = evaluateReleaseBump({
      changedFiles: ["README.md", "AGENTS.md", "tests/unit/foo.test.js"],
      baseVersion: "0.15.184",
      headVersion: "0.15.184",
      lockVersion: "0.15.184",
      changelogTopVersion: "0.15.184",
    });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it("passes a code change that bumped everything consistently", () => {
    const r = evaluateReleaseBump({
      changedFiles: ["open-sse/rtk/systemInject.js", "CHANGELOG.md", "package.json"],
      ...good,
    });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it("fails a code change that did not move the version", () => {
    const r = evaluateReleaseBump({
      changedFiles: ["open-sse/rtk/systemInject.js"],
      baseVersion: "0.15.184",
      headVersion: "0.15.184",
      lockVersion: "0.15.184",
      changelogTopVersion: "0.15.184",
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/version is still 0\.15\.184/);
  });

  it("fails a version that went backwards", () => {
    const r = evaluateReleaseBump({
      changedFiles: ["open-sse/rtk/systemInject.js"],
      baseVersion: "0.15.185",
      headVersion: "0.15.184",
      lockVersion: "0.15.184",
      changelogTopVersion: "0.15.184",
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/went backwards/);
  });

  it("fails when the changelog does not lead with the new version", () => {
    const r = evaluateReleaseBump({
      changedFiles: ["open-sse/rtk/systemInject.js", "package.json"],
      baseVersion: "0.15.184",
      headVersion: "0.15.185",
      lockVersion: "0.15.185",
      changelogTopVersion: "0.15.184",
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/CHANGELOG\.md's top entry/);
  });

  it("fails when the lockfile version disagrees with package.json", () => {
    const r = evaluateReleaseBump({
      changedFiles: ["open-sse/rtk/systemInject.js", "package.json"],
      baseVersion: "0.15.184",
      headVersion: "0.15.185",
      lockVersion: "0.15.184",
      changelogTopVersion: "0.15.185",
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/package-lock\.json version is 0\.15\.184/);
  });

  it("fails a skills change without a bump (the gateway serves them)", () => {
    const r = evaluateReleaseBump({
      changedFiles: ["skills/ponytail-review/SKILL.md"],
      baseVersion: "0.15.184",
      headVersion: "0.15.184",
      lockVersion: "0.15.184",
      changelogTopVersion: "0.15.184",
    });
    expect(r.ok).toBe(false);
  });
});
