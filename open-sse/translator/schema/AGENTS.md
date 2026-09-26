<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# schema

## Purpose
Translator enums and constants: role names, Claude block types, model markers. The anti-hardcode source every translator imports.

## For AI Agents

### Working In This Directory
- New literal (role, block type, stop reason) goes here first, then translators import it — never inline the string.
- Keep this dependency-free (no imports from translators or executors) to avoid cycles.

<!-- MANUAL: -->
