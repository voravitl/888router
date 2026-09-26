<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# skills

## Purpose
Drop-in agent skills served by the gateway (`<host>/api/skills/raw/<id>`): setup entry plus per-capability skills (chat, embeddings, image, STT, TTS, web-fetch, web-search) and SearXNG search.

## Key Files
| File | Description |
|------|-------------|
| `README.md` | Skill index with copy-paste links for agents |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `9router/` | Entry skill: setup + links to all capability skills |
| `9router-chat/` | Chat/completion skill (`SKILL.md`) |
| `9router-embeddings/` | Embeddings skill |
| `9router-image/` | Image generation skill |
| `9router-stt/` | Speech-to-text skill |
| `9router-tts/` | Text-to-speech skill |
| `9router-web-fetch/` | Web fetch skill |
| `9router-web-search/` | Web search skill |
| `searxng/` | SearXNG search skill |

## For AI Agents

### Working In This Directory
- Skills are API-served markdown — dashboard `/dashboard/skills` shows absolute copy-paste URLs; behind a proxy set `NINEROUTER_PUBLIC_URL` so served markdown embeds the right origin.
- Each skill dir centers on `SKILL.md`; keep capability scope to its directory.

## Dependencies

### Internal
- `../src/app/api/skills/` — serving route for these skills

<!-- MANUAL: -->
