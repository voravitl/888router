import { describe, it, expect } from "vitest";

// The dashboard and the engine each hold a list of ponytail levels:
//   - src/app/(dashboard)/dashboard/endpoint/endpointConstants.js  (UI: labels)
//   - open-sse/rtk/ponytailPrompt.js                               (engine: prompts)
//
// They drifted before (the dashboard advertised levels the engine had no
// prompt for), and the failure mode is SILENT: injectPonytail() calls
// injectSystemPrompt(body, format, undefined) and systemInject.js returns
// early on a falsy prompt — so the feature is off, with no error anywhere.
//
// A level id that exists in the UI but not in the engine is a bug the user
// only sees as "I turned it on and nothing happened". Pin the two lists
// against each other.
import { PONYTAIL_LEVELS as DASHBOARD_LEVELS } from "../../src/app/(dashboard)/dashboard/endpoint/endpointConstants.js";
import { PONYTAIL_LEVELS as ENGINE_LEVELS, PONYTAIL_PROMPTS } from "../../open-sse/rtk/ponytailPrompt.js";

describe("ponytail levels: dashboard and engine agree", () => {
  it("offers exactly the same level ids on both sides", () => {
    const dash = DASHBOARD_LEVELS.map((l) => l.id).sort();
    const engine = Object.values(ENGINE_LEVELS).sort();
    expect(dash).toEqual(engine);
  });

  it("has a prompt for every level the dashboard offers", () => {
    for (const { id } of DASHBOARD_LEVELS) {
      expect(typeof PONYTAIL_PROMPTS[id], `no prompt for level "${id}"`).toBe("string");
      expect(PONYTAIL_PROMPTS[id].length).toBeGreaterThan(0);
    }
  });

  it("gives every level a label and a description for the UI", () => {
    for (const lvl of DASHBOARD_LEVELS) {
      expect(lvl.label, `level ${lvl.id} has no label`).toBeTruthy();
      expect(lvl.desc, `level ${lvl.id} has no desc`).toBeTruthy();
    }
  });

  it("does not advertise a level the engine has no prompt for (silent-disable guard)", () => {
    // The failure this guards: dashboard offers "wenyan-ultra", the engine has
    // no such prompt, injectPonytail() passes undefined, systemInject.js
    // returns early, and the feature is off with no error anywhere.
    const engineIds = new Set(Object.values(ENGINE_LEVELS));
    for (const { id } of DASHBOARD_LEVELS) {
      expect(engineIds.has(id), `dashboard level "${id}" has no engine prompt`).toBe(true);
    }
  });

  it("keeps the default level valid", () => {
    // src/lib/db/repos/settingsRepo.js defaults ponytailLevel to "full".
    const engineIds = new Set(Object.values(ENGINE_LEVELS));
    expect(engineIds.has("full")).toBe(true);
  });

  it("describes the ladder in the same order everywhere", () => {
    // The ladder starts with "does it need to exist at all?" (YAGNI), then
    // "already in this codebase", then stdlib. The dashboard blurb and the
    // prompt's own level line used to say "codebase first" and put YAGNI last
    // — the user-visible text described a ladder the model never receives.
    const full = PONYTAIL_PROMPTS.full;
    const levelLine = full.slice(0, full.indexOf("The smallest complete change"));
    expect(levelLine.indexOf("need to exist")).toBeGreaterThan(-1);
    expect(levelLine.indexOf("need to exist")).toBeLessThan(levelLine.indexOf("codebase"));

    const desc = DASHBOARD_LEVELS.find((l) => l.id === "full").desc;
    expect(desc.indexOf("exist")).toBeGreaterThan(-1);
    expect(desc.indexOf("exist")).toBeLessThan(desc.indexOf("codebase"));
  });
});
