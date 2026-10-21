---
name: ponytail-audit
description: Audit a whole repository like the senior developer who just inherited it - bugs, security, real load, risky logic without a test, slow paths, and what to cut, ranked most important first. Use when the user says "ponytail audit", "audit this repo", or asks for a whole-codebase quality review.
---

# Ponytail Audit

Adapted from the ponytail skill (https://github.com/DietrichGebert/ponytail),
upstream `commands/ponytail-audit.toml`, v5 (verified 2026-10-21).

The gateway injects the ponytail system prompt into the request it forwards
(see `/api/skills/raw/9router-chat` for how to call it). This skill is the
AUDIT half: it needs a repository to read, so run it where the code is.

## What to audit

The whole repository, or the folder the user names.

## Map first

README, deploy and build config, dependencies, entry points, tests. Find the
expected load: one person, or many users and processes.

Then trace the main flows and read fully the paths with user input, money,
auth, data writes, background jobs and shared state.

## What to look for, in this order

1. **Bugs** — wrong result, crash, missed edge case.
2. **Risk** — security holes, data loss.
3. **Scale** — races, the same work done by every process, memory that only
   grows, a query per item, O(n²).
4. **Risky logic without a test.**
5. **Slow code** — big is a problem, small is a suggestion.
6. **Lean** — dead code, duplicate helpers, stdlib or native instead of custom
   code or a dependency, abstractions with one implementation, near-copies to
   merge, a function doing several unrelated jobs to split (never split by line
   count).

Before calling code unused, grep the whole tree — including tests, fixtures,
config and string references.

## Rules

- Every finding needs a concrete case.
- A `shortcut:` (or older `ponytail:`) comment that names its limit is a
  DECISION, not a finding.
- Propose the smallest fix. Prefer deleting code. Never add layers.
- No style taste, no vague worries.
- Very simple English; explain technical terms.
- Change no code.

## Output

Start with **"What this repo does:"** and the load you assumed.

Then at most 20 numbered findings, grouped **Must fix / Should fix / Nice to
have**, most important first. Each:

- a bold title with `file:lines`
- four bullets: **What this is**, **Problem**, **Fix**, **If we skip it**

End with:

- **Verdict:**
- **Lean: -N lines, -M dependencies possible.**
- **Not checked:** for the parts you did not read

Nothing found: **"Looks good. Ship."**
