---
name: 9router-searxng
description: Web search via 9Router /v1/search using the SearXNG provider. Use when the user wants to search the web, research a topic, or look up information through a self-hosted SearXNG instance routed by 9Router.
---

# 9Router — SearXNG Search

Requires `NINEROUTER_URL` (and `NINEROUTER_KEY` if auth enabled). See /api/skills/raw/9router for setup.

## Discover

```bash
curl "$NINEROUTER_URL/v1/models/web" | jq '.data[] | select(.id=="searxng") | .id'
curl "$NINEROUTER_URL/v1/models/info?id=searxng"   # searchTypes, maxResults, timeout
```

## Endpoint

`POST $NINEROUTER_URL/v1/search`

| Field | Required | Notes |
|---|---|---|
| `model` | yes | `"searxng"` |
| `query` | yes | search terms |
| `search_type` | yes | `"web"` or `"news"` |
| `max_results` | no | default 5, max 50 |

## Example

```bash
curl -s -X POST $NINEROUTER_URL/v1/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $NINEROUTER_KEY" \
  -d '{
    "model": "searxng",
    "query": "latest news about AI",
    "search_type": "web",
    "max_results": 5
  }'
```

Response: `results[]` with `title`, `url`, `snippet`, `citation` (provider + rank).

## Notes

- SearXNG is a self-hosted meta-search aggregator (DuckDuckGo, Google CSE, Wikipedia, …).
- It must be running (in 9Router's docker-compose as service `searxng`, internal port 8080).
- The gateway reaches it by service name, not localhost (the container-localhost footgun).
- Search engines can be flaky (403/CAPTCHA) — that's the upstream, retry or narrow the query.
- Results are cached (cacheTTLMs ~180s); don't hammer with rapid-fire identical queries.
