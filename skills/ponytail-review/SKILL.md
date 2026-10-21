---
name: ponytail-review
description: Review code changes like the senior developer who gets paged when they break - bugs, security, real load, risky logic without a test, slow paths, and what to cut. Use when the user says "ponytail review", "review this diff", "review my changes", or asks for a review that also says what can be deleted.
---

# Ponytail Review

Adapted from the ponytail skill (https://github.com/DietrichGebert/ponytail),
upstream `commands/ponytail-review.toml`, v5 (verified 2026-10-21).

The gateway injects the ponytail system prompt into the request it forwards
(see `/api/skills/raw/9router-chat` for how to call it). This skill is the
REVIEW half: it needs a repository to read, so run it where the code is.

## What to review

What the user names — `uncommitted`, `staged`, a branch, a PR link, or files.
Nothing named: the uncommitted changes, or the last commit if there are none.

## Before you read

Read the code the change touches: the callers of every changed function, the
functions it calls, the tests, and the README (find the expected load — one
person, or many users and processes). A change can break code it does not
touch.

## What to look for, in this order

1. **Bugs** — wrong result, crash, missed edge case, a caller broken by the
   change, a fix applied in one caller while the shared function stays broken.
2. **Risk** — security holes, data loss.
3. **Scale** — check-then-write races, the same work done by every process,
   memory that only grows, a query per item, O(n²) on big input.
4. **Risky logic without a test.**
5. **Slow code** — big is a problem, small is a suggestion.
6. **Lean** — dead code, a helper the repo already has, stdlib or native
   instead of custom code or a new dependency, abstractions with one
   implementation, near-copies to merge, a function doing several unrelated
   jobs to split (never split by line count).

Before calling code unused, grep the whole tree — including tests, fixtures,
config and string references.

## Rules

- Every finding needs a concrete case. Re-read the lines to confirm it.
- A `shortcut:` (or older `ponytail:`) comment that names its limit is a
  DECISION, not a finding.
- Propose the smallest fix. Prefer deleting code. Never add layers.
- No style taste, no vague worries.
- Very simple English; explain technical terms.
- Change no code.

## Output

Start with **"What this change does:"** in two or three sentences, and the
load you assumed.

Then numbered findings grouped **Must fix / Should fix / Nice to have**:

- a bold title with `file:lines`
- four bullets: **What this is**, **Problem**, **Fix**, **If we skip it**
  (one or two short sentences each)

End with:

- **Verdict:**
- **Lean: -N lines possible.** when lean findings exist
- **Not checked:** for anything that mattered and you could not check

Nothing found: **"Looks good. Ship."**
