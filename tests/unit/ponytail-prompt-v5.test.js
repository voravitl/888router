import { describe, it, expect } from "vitest";

// The ponytail prompt in open-sse/rtk/ponytailPrompt.js is an adaptation of
// the upstream skill (https://github.com/DietrichGebert/ponytail). Upstream
// rewrote it completely in v5 — new structure, a reordered ladder, and rules
// that did not exist in the pre-v5 text this file was adapted from.
//
// A prompt is a product surface: it decides how every downstream agent writes
// code. Silently drifting away from upstream (or from the version upstream
// actually ships) is how it rots. These tests pin the STRUCTURE so a future
// edit has to be deliberate.
//
// Verified against upstream main on 2026-10-21 (skills/ponytail/SKILL.md and
// AGENTS.md).

import { PONYTAIL_PROMPTS, PONYTAIL_LEVELS } from "../../open-sse/rtk/ponytailPrompt.js";

const ALL = Object.values(PONYTAIL_LEVELS);
const promptFor = (level) => PONYTAIL_PROMPTS[level];

describe("ponytail prompt structure (upstream v5)", () => {
  it("exposes exactly the three upstream levels", () => {
    expect(Object.values(PONYTAIL_LEVELS).sort()).toEqual(["full", "lite", "ultra"]);
    for (const level of ALL) {
      expect(typeof PONYTAIL_PROMPTS[level]).toBe("string");
      expect(PONYTAIL_PROMPTS[level].length).toBeGreaterThan(0);
    }
  });

  it("every level carries the shared core rules", () => {
    for (const level of ALL) {
      const p = promptFor(level);
      // Persona — upstream's opening line, verbatim in intent.
      expect(p).toMatch(/lazy senior developer/i);
      // The ladder and its rules survive the level switch.
      expect(p).toMatch(/stdlib|standard library/i);
      expect(p).toMatch(/does it need to exist/i);
      // Output contract.
      expect(p).toMatch(/skipped/i);
      // The never-cut list.
      expect(p).toMatch(/validation/i);
      expect(p).toMatch(/security/i);
      expect(p).toMatch(/accessibility/i);
    }
  });

  it("carries the v5 'Before you write' scope step (absent from pre-v5)", () => {
    // Upstream v5 added this section: read the code the change touches, list
    // every place it must reach, and check what it could break for users.
    for (const level of ALL) {
      const p = promptFor(level);
      expect(p).toMatch(/before you write/i);
      // The scope enumeration itself.
      expect(p).toMatch(/callers/i);
      expect(p).toMatch(/tests/i);
    }
  });

  it("orders the ladder with 'already in this codebase' at rung 2 (v5 order)", () => {
    // Upstream v5 put "already in this codebase" BEFORE "standard library".
    // The pre-v5 text had stdlib at rung 2. The order is the point of the
    // ladder: reuse the house component before reaching for a native widget.
    //
    // Compare the positions INSIDE the ladder, not the first occurrence in the
    // whole prompt — the shared rules also mention stdlib, and the level
    // blurb may too, so a whole-string search measures the wrong thing.
    for (const level of ALL) {
      const p = promptFor(level);
      const ladder = p.match(/The smallest complete change[^]*?(?=Be lazy about)/i)?.[0]
        ?? p.match(/The smallest complete change[^]*/i)?.[0]
        ?? "";
      expect(ladder, `level=${level}: ladder not found`).not.toBe("");
      const inCodebase = ladder.search(/already in this (codebase|repo)/i);
      const stdlib = ladder.search(/standard library|stdlib/i);
      expect(inCodebase, `level=${level}`).toBeGreaterThan(-1);
      expect(stdlib, `level=${level}`).toBeGreaterThan(-1);
      expect(inCodebase, `level=${level}: "already in this codebase" must come before "standard library" in the ladder`)
        .toBeLessThan(stdlib);
    }
  });

  it("keeps the v5 rules that the pre-v5 text lacked", () => {
    for (const level of ALL) {
      const p = promptFor(level);
      // Root-cause the fix in shared code, not per call site.
      expect(p).toMatch(/root cause/i);
      // Moved/merged code keeps its validation.
      expect(p).toMatch(/moves? or merges?/i);
      // Edge-case-correct wins over equally short.
      expect(p).toMatch(/edge case/i);
      // Comment only the why, in one line.
      expect(p).toMatch(/comment only the why/i);
    }
  });

  it("ends with the v5 output contract", () => {
    // Upstream v5: "End your reply with one or two lines: what you skipped or
    // did not check, and any risk the user must know." The pre-v5 text said
    // "at most three short lines" and prefixed "Code first." — neither is in
    // upstream v5, and the commit message claimed the three-line contract as a
    // v5 feature.
    for (const level of ALL) {
      const p = promptFor(level);
      expect(p).toMatch(/one or two lines/i);
      expect(p).not.toMatch(/at most three short lines/i);
      expect(p).not.toMatch(/Code first\./);
    }
  });

  it("names the shortcut comment format upstream's /ponytail-debt harvests", () => {
    // Upstream: `shortcut: <the limit>, <when to upgrade>`. The pre-v5 text
    // said `ponytail:` — a word /ponytail-debt does not look for, so the
    // ledger stayed empty. The gateway's own code comments use the same
    // marker (see open-sse/services/combo.js, comboStreamGuard.js).
    for (const level of ALL) {
      const p = promptFor(level);
      expect(p).toMatch(/shortcut:/);
      expect(p).not.toMatch(/`ponytail:` comment/);
    }
  });

  it("keeps the level differences distinct", () => {
    const lite = promptFor(PONYTAIL_LEVELS.LITE);
    const full = promptFor(PONYTAIL_LEVELS.FULL);
    const ultra = promptFor(PONYTAIL_LEVELS.ULTRA);
    // lite: build what was asked, name the smaller option.
    expect(lite).toMatch(/name the (smaller|lazier) option/i);
    // ultra: push back on the request itself.
    expect(ultra).toMatch(/push back|question the request/i);
    // full is the default level.
    expect(full).toMatch(/shortest diff/i);
    // The three are not the same string.
    expect(new Set([lite, full, ultra]).size).toBe(3);
  });
});
