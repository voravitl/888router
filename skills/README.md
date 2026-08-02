# 9Router — Agent Skills

Drop-in skills for any AI agent (Claude, Cursor, ChatGPT, custom SDK). Just **copy a link** below and paste it to your AI — it will fetch the skill and use 9Router for you.

> Tip: start with the **9router** entry skill — it covers setup and links to all capability skills.
>
> The paths below are **API-served only**: they work when fetched from a running 9Router gateway (`<host>/api/skills/raw/<id>`). The dashboard at `/dashboard/skills` shows absolute URLs you can copy directly — use that for production / remote agents. If the gateway is behind a reverse proxy / tunnel, set `NINEROUTER_PUBLIC_URL` (e.g. `https://gateway.example.com`) so served markdown embeds the correct public origin.

## Skills

| Capability | Path (relative to your host — dashboard shows absolute) |
|---|---|
| **Entry / Setup** (start here) | /api/skills/raw/9router |
| Chat / code-gen | /api/skills/raw/9router-chat |
| Image generation | /api/skills/raw/9router-image |
| Text-to-speech | /api/skills/raw/9router-tts |
| Speech-to-text | /api/skills/raw/9router-stt |
| Embeddings | /api/skills/raw/9router-embeddings |
| Web search | /api/skills/raw/9router-web-search |
| Web fetch (URL → markdown) | /api/skills/raw/9router-web-fetch |

> **Production note:** the paths above are API-served only — fetch them from a
> running gateway (`<host>/api/skills/raw/<id>`) or copy absolute URLs from the
> dashboard at `/dashboard/skills`. Behind a reverse proxy / tunnel, set
> `NINEROUTER_PUBLIC_URL` (e.g. `https://gateway.example.com`) so served
> markdown embeds the correct public origin.

## How to use

Paste to your AI (Claude, Cursor, ChatGPT, …) — use an absolute URL:

```
Read this skill and use it: http://localhost:20128/api/skills/raw/9router
```

(Replace `http://localhost:20128` with your VPS / tunnel URL if you're not on the same machine.)

Then ask normally — *"generate an image of a cat"*, *"transcribe this URL"*, etc.

## Configure your shell once

```bash
export NINEROUTER_URL="http://localhost:20128"   # local default, or your VPS / tunnel URL
export NINEROUTER_KEY="sk-..."                   # from Dashboard → Keys (only if requireApiKey=true)
```

Verify: `curl $NINEROUTER_URL/api/health` → `{"ok":true}`.

## Links

- Source: https://github.com/decolua/9router
- Dashboard: https://9router.com
