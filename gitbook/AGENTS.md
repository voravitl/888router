<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# gitbook

## Purpose
Standalone multilingual docs site (own `package.json`, Next.js): localized content (`en/es/ja/vi/zh-CN`), docs app shell, and content-loading lib. Independent from the main gateway app.

## Key Files
| File | Description |
|------|-------------|
| `package.json` | Docs-site manifest (independent) |
| `next.config.mjs` | Docs-site Next config |
| `jsconfig.json` | Path aliases for docs site |
| `postcss.config.mjs` | Docs-site CSS pipeline |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `app/` | Docs app shell (`[lang]` routes, layout, globals) |
| `content/` | Localized markdown per locale (en, es, ja, vi, zh-CN) |
| `components/` | Docs-site UI components |
| `constants/` | Docs-site constants |
| `lib/` | Content loader (`content.js`) |
| `utils/` | Docs-site utils |

## For AI Agents

### Working In This Directory
- Separate Next.js app with its own deps — install/build inside `gitbook/`, never from repo root.
- New locale means a new `content/<locale>/` tree plus wiring in `app/[lang]`.

## Dependencies

### External
- Next.js (docs-site owned version in `gitbook/package.json`)

<!-- MANUAL: -->
