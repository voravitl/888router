# ☁️ Docker Deployment

Deploy 9Router via Docker Compose for production / remote access.

> This project is **9Router** (the gateway), published as the **`888router`**
> image from the `voravitl/888router` repository. The compose stack runs
> **one** gateway, the `888route` service (host port `20129`), beside
> `headroom` (optional token-saver proxy), `searxng` (search proxy) and
> `watchtower` (pulls new gateway releases).

---

## 🐳 Quick Start (Docker Compose)

### Prerequisites

- Docker with **Compose v2** (`docker compose version`)
- A machine that can run **linux/amd64 or linux/arm64** containers — the
  published image is **multi-arch** (Intel/AMD VPS **and** Apple Silicon)

### Step 1: Clone + configure

```bash
git clone https://github.com/voravitl/888router.git
cd 888router

cp .env.example .env.route
# edit .env.route — REQUIRED: JWT_SECRET, INITIAL_PASSWORD, SEARXNG_SECRET
```

### Step 2: Start the stack

```bash
# compose reads SEARXNG_SECRET from the shell or from .env
export SEARXNG_SECRET="$(grep '^SEARXNG_SECRET=' .env.route | cut -d= -f2-)"
docker compose up -d
```

The gateway is served at `http://localhost:20129` (dashboard at
`http://localhost:20129/dashboard`). Inside the container the app listens on
`20128`; compose publishes it on host port `20129`.

### Step 3: Verify

```bash
curl http://localhost:20129/api/version
# → {"currentVersion":"<package.json version>",...}
```

---

## 📦 Where does the image come from?

By default `docker-compose.yml` pulls the **published** image
`voravitl/888router:latest`. CI (`.github/workflows/docker-publish.yml`)
builds and pushes it automatically:

| Trigger | Tag |
|---------|-----|
| Every `master` push | `latest` |
| Release tag `v0.14.11` | `0.14.11` |
| Every `master` push | `sha-<7char>` (traceability) |

The image is published to **Docker Hub** (`voravitl/888router`) and **GHCR**
(`ghcr.io/voravitl/888router`), both multi-arch (`linux/amd64,linux/arm64`).

### Build from this repo instead (forks / local changes)

If you forked the repo or changed code, uncomment the `build:` block in
`docker-compose.yml` and rebuild:

```bash
docker compose up -d --build
```

---

## 🔑 Environment Variables

`docker-compose.yml` loads `.env.route` into the gateway via `env_file` and
sets some values inline. The variables **required for the compose stack** are:

| Variable | Required | Notes |
|----------|----------|-------|
| `JWT_SECRET` | ✅ | JWT signing secret — `openssl rand -hex 32` |
| `INITIAL_PASSWORD` | ✅ | Dashboard login on first boot |
| `SEARXNG_SECRET` | ✅ | **Compose aborts if unset** — SearXNG refuses a known-in-git default. `openssl rand -hex 32` |

Optional / commonly used:

| Variable | Default | Notes |
|----------|---------|-------|
| `NINEROUTER_PUBLIC_URL` | *(unset)* | Public origin for skill links. Set to `https://gateway.example.com` behind a proxy, else links point at localhost |
| `PORT` | `20128` | Port the app listens on inside the container (compose publishes it on host port `20129`) |
| `DATA_DIR` | `/app/data` (in container) | Persisted via the `888route-data` volume |
| `TZ` | `Asia/Bangkok` | Usage-stats timezone |
| `ENABLE_REQUEST_LOGS` | `false` | Debug request/response logs |
| `OBSERVABILITY_ENABLED` | `true` | Observability on |
| `BASE_URL` / `NEXT_PUBLIC_BASE_URL` | `http://localhost:20129` | Public base for cloud-sync |

> ⚠️ Never commit `.env` or `.env.route`. Both are git-ignored. `.env.example`
> is the documented template.

---

## 🧱 What the compose stack runs

| Service | Image | Purpose |
|---------|-------|---------|
| `888route` | `voravitl/888router:latest` | The gateway — the only one (host port `20129` → container port `20128`) |
| `headroom` | `ghcr.io/headroomlabs-ai/headroom:latest` | Optional token-saver `/v1/compress` proxy (port `8787`, internal) |
| `searxng` | `searxng/searxng:latest` | Search proxy (internal only, port `8080`) |
| `watchtower` | `containrrr/watchtower` (pinned digest) | Pulls and recreates `888route` when a new `:latest` is published |

- `headroom` and `searxng` are reached **by service name** from the gateway
  (`http://headroom:8787`, `http://searxng:8080/search`) — not localhost.
- SearXNG is intentionally **not** published to a public port (open-proxy /
  SSR abuse risk). To expose it for local dev, use a separate override.
- `searxng/settings.yml` is mounted read-only from the repo (reproducible
  config; the app must not rewrite it).

---

## 🧹 Updating

```bash
git pull
docker compose pull 888route   # or: docker compose up -d --build for local builds
docker compose up -d 888route
```

---

## 🔁 Reverse Proxy (Nginx)

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:20129;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE support — CRITICAL for streaming
        proxy_buffering off;
        proxy_read_timeout 86400;
    }
}
```

Terminate TLS with certbot as usual, and set `NINEROUTER_PUBLIC_URL` to the
public `https://your-domain.com` so served links are absolute.

---

## 🔐 Security Notes

- **Change the defaults** — `JWT_SECRET`, `INITIAL_PASSWORD`, and
  `SEARXNG_SECRET` must all be unique per deployment.
- The gateway exposes only host port `20129`. Put it behind a reverse proxy /
  VPN for production; don't publish it raw to the public internet without auth.
- SearXNG stays internal — do not publish its port to a public host.

---

## 🚨 Troubleshooting

**`no matching manifest for linux/amd64`** — you're pulling an arm64-only
image on an Intel host. This was fixed by multi-arch publishing; if you still
see it, you're on an older image — `docker compose pull` to fetch the latest.

**`set SEARXNG_SECRET in .env`** — compose aborted because `SEARXNG_SECRET` is
not set in the shell or in `.env`. Export it (see Step 2) and retry.

**Gateway logs / health**:

```bash
docker compose logs -f 888route
docker compose ps
```

---

## 🔗 Next Steps

- [Connect Providers](/providers/subscription.md)
- [Setup Combos](/features/combos.md)
- [Integrate with Tools](/integration/claude-code.md)
