import { describe, it, expect, beforeEach } from "vitest";

// Regression guard: the ponytail/caveman system prompt is appended to the
// system message on EVERY request. If the client already sent that prompt
// (a resumed session, or a client that echoes the system block back each
// turn), the gateway appended a second copy — observed live 2026-10-21:
// outbound persona count 2 when the client sent 1.
//
// A duplicated instruction block is not cosmetic: it doubles the system
// prefix (cache cost), and a prompt that states its rules twice reads as
// emphasis to the model.
//
// The dedupe must be EXACT — the same prompt text, not a fuzzy match. Two
// different savers (ponytail + caveman) legitimately inject two different
// blocks, and a client that sends a prompt we do not know must still get
// ours appended.
//
// It does NOT cover a client that brings its own ponytail plugin: that plugin
// sends upstream's wording, not ours, so the text differs and both rule sets
// end up in the request. One owner at a time — the gateway's toggle or the
// client's plugin.

import { injectSystemPrompt } from "../../open-sse/rtk/systemInject.js";
import { injectPonytail } from "../../open-sse/rtk/ponytail.js";
import { injectCaveman } from "../../open-sse/rtk/caveman.js";
import { PONYTAIL_PROMPTS } from "../../open-sse/rtk/ponytailPrompt.js";
import { CAVEMAN_PROMPTS } from "../../open-sse/rtk/cavemanPrompts.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const PONYTAIL = PONYTAIL_PROMPTS.full;
const CAVEMAN = CAVEMAN_PROMPTS.full;

const count = (haystack, needle) => {
  if (typeof haystack !== "string" || !needle) return 0;
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
};

describe("system prompt injection is idempotent per prompt", () => {
  it("does not append the ponytail prompt twice when the client already sent it", () => {
    const body = {
      messages: [
        { role: "system", content: `You are helpful.\n\n${PONYTAIL}` },
        { role: "user", content: "hi" },
      ],
    };
    injectPonytail(body, FORMATS.OPENAI, "full");
    expect(count(body.messages[0].content, PONYTAIL)).toBe(1);
  });

  it("does not append the ponytail prompt twice on a Claude-shaped body", () => {
    const body = {
      system: `You are helpful.\n\n${PONYTAIL}`,
      messages: [{ role: "user", content: "hi" }],
    };
    injectPonytail(body, FORMATS.CLAUDE, "full");
    expect(count(body.system, PONYTAIL)).toBe(1);
  });

  it("still appends when the client sent a DIFFERENT system prompt", () => {
    const body = {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "hi" },
      ],
    };
    injectPonytail(body, FORMATS.OPENAI, "full");
    expect(count(body.messages[0].content, PONYTAIL)).toBe(1);
  });

  it("keeps the two savers separate — ponytail and caveman both apply", () => {
    const body = {
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hi" },
      ],
    };
    injectPonytail(body, FORMATS.OPENAI, "full");
    injectCaveman(body, FORMATS.OPENAI, "full");
    const sys = body.messages[0].content;
    expect(count(sys, PONYTAIL)).toBe(1);
    expect(count(sys, CAVEMAN)).toBe(1);
  });

  it("dedupes caveman independently of ponytail", () => {
    const body = {
      messages: [
        { role: "system", content: `You are helpful.\n\n${CAVEMAN}` },
        { role: "user", content: "hi" },
      ],
    };
    injectCaveman(body, FORMATS.OPENAI, "full");
    expect(count(body.messages[0].content, CAVEMAN)).toBe(1);
  });

  it("does not treat a different level's prompt as the same one", () => {
    // A client on "lite" must not suppress the gateway's "full" prompt: they
    // are different instructions, and silently swapping one for the other
    // would change behaviour without telling anyone.
    const body = {
      messages: [
        { role: "system", content: `You are helpful.\n\n${PONYTAIL_PROMPTS.lite}` },
        { role: "user", content: "hi" },
      ],
    };
    injectPonytail(body, FORMATS.OPENAI, "full");
    expect(count(body.messages[0].content, PONYTAIL_PROMPTS.full)).toBe(1);
  });

  it("leaves the body untouched when there is no system slot and no prompt", () => {
    // A body with no messages array cannot be injected into — it must not be
    // mutated into something invalid.
    const body = { model: "x" };
    injectSystemPrompt(body, FORMATS.OPENAI, PONYTAIL);
    expect(body).toEqual({ model: "x" });
  });

  // The three list shapes below are the ones real traffic uses. The prompt is
  // never the WHOLE block there: openai-to-claude.js puts the client's entire
  // system message into one block, so the block reads "You are helpful.\n\n<prompt>".
  // A check that asks "is this block exactly the prompt?" never matches, and the
  // gateway appends the prompt a second time.
  it("does not append twice when the OpenAI system is an array of parts", () => {
    const body = {
      messages: [
        { role: "system", content: [{ type: "text", text: `You are helpful.\n\n${PONYTAIL}` }] },
        { role: "user", content: "hi" },
      ],
    };
    injectPonytail(body, FORMATS.OPENAI, "full");
    const text = body.messages[0].content.map((p) => p.text || "").join("");
    expect(count(text, PONYTAIL)).toBe(1);
  });

  it("does not append twice when the Claude system is an array of blocks", () => {
    // This is the shape openai-to-claude.js actually builds: result.system is
    // always an array of {type:"text"} blocks.
    const body = {
      system: [{ type: "text", text: `You are helpful.\n\n${PONYTAIL}` }],
      messages: [{ role: "user", content: "hi" }],
    };
    injectPonytail(body, FORMATS.CLAUDE, "full");
    const text = body.system.map((b) => b.text || "").join("");
    expect(count(text, PONYTAIL)).toBe(1);
  });

  it("does not append twice when the Gemini system_instruction holds parts", () => {
    const body = {
      system_instruction: { parts: [{ text: `You are helpful.\n\n${PONYTAIL}` }] },
    };
    injectPonytail(body, FORMATS.GEMINI, "full");
    const text = body.system_instruction.parts.map((p) => p.text || "").join("");
    expect(count(text, PONYTAIL)).toBe(1);
  });

  it("still appends into a list shape when the client sent a DIFFERENT prompt", () => {
    // The dedupe must not turn into a blanket "skip if the system is non-empty".
    const body = {
      system: [{ type: "text", text: `You are helpful.\n\n${PONYTAIL_PROMPTS.lite}` }],
      messages: [{ role: "user", content: "hi" }],
    };
    injectPonytail(body, FORMATS.CLAUDE, "full");
    const text = body.system.map((b) => b.text || "").join("");
    expect(count(text, PONYTAIL_PROMPTS.full)).toBe(1);
  });
});
