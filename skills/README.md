# 9Router — Agent Skills

Drop-in skills for any AI agent (Claude, Cursor, ChatGPT, custom SDK). Just **copy a link** below and paste it to your AI — it will fetch the skill and use 9Router for you.

> Tip: start with the **9router** entry skill — it covers setup and links to all capability skills.

## Skills

| Capability | Copy link below and paste to your AI |
|---|---|
| **Entry / Setup** (start here) | /api/skills/raw/9router |
| Chat / code-gen | /api/skills/raw/9router-chat |
| Image generation | /api/skills/raw/9router-image |
| Text-to-speech | /api/skills/raw/9router-tts |
| Speech-to-text | /api/skills/raw/9router-stt |
| Embeddings | /api/skills/raw/9router-embeddings |
| Web search | /api/skills/raw/9router-web-search |
| Web fetch (URL → markdown) | /api/skills/raw/9router-web-fetch |

## How to use

Paste to your AI (Claude, Cursor, ChatGPT, …):

```
Read this skill and use it: /api/skills/raw/9router
```

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
