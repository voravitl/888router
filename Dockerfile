# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS base
WORKDIR /app

FROM base AS builder

RUN apk --no-cache upgrade && apk --no-cache add python3 make g++ linux-headers

# Reproducible deps: commit package-lock.json + use npm ci (deterministic),
# NOT npm install (resolves ranges → image changes every build). Copy lock
# before source so dependency layer only invalidates when the lock changes.
COPY package.json package-lock.json ./
ARG BUILD_VERSION=""
RUN --mount=type=cache,target=/root/.npm \
  npm ci

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN mkdir -p /app/data && npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="9router"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

# Time zone for usage stats — Thailand time (default, override via -e TZ=<zone>)
# docker run -e TZ=Europe/Berlin ... to use a different zone
RUN apk --no-cache add tzdata su-exec
ENV TZ=Asia/Bangkok

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/open-sse ./open-sse
# Ship the OMC HUD provider script + setup instruction so users can install
# via `docker cp 888router:/app/cli/scripts/...` (see install-hud.md).
COPY --from=builder /app/cli/scripts ./cli/scripts
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --from=builder /app/node_modules/next ./node_modules/next
# sql.js loads dist/sql-wasm.wasm by path at runtime; tracing only follows JS imports,
# so the last-resort DB driver would abort with ENOENT on the missing binary.
COPY --from=builder /app/node_modules/sql.js ./node_modules/sql.js

RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home && chown node:node /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

# Dual-mode entrypoint (su-exec / gosu pattern, like the official postgres/redis images):
#   * as root (plain `docker run`, possibly a root-owned bind mount) -> chown the data
#     dirs, then drop to the unprivileged `node` user.
#   * already non-root (k8s runAsUser=1000 + drop ALL caps) -> exec directly. Calling
#     su-exec here would hit setgroups() EPERM because CAP_SETGID is dropped, which is
#     exactly what crash-looped image 0.15.99 ("su-exec: setgroups: Operation not
#     permitted" -> CrashLoopBackOff -> ingress 503). See docker-entrypoint.sh.
# No hard-coded `USER`: k8s pins runAsUser=1000 (non-root path); plain Docker starts as
# root so the entrypoint can fix volume ownership before dropping privileges.
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "custom-server.js"]
