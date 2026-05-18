# Multi-stage Dockerfile for `@dokhna-tech/zatca-server`.
#
# - Base: node:20-slim (NOT distroless — OpenSSL CLI is required by
#   the core package's CSR + keygen probe).
# - Non-root runtime user.
# - tini as PID 1 for proper signal handling.

############ Stage 1 — install + build ############
FROM node:20-slim AS build

WORKDIR /workspace

# Install pnpm via corepack. Pin to the version declared in the repo
# so layer-cache stays warm.
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Copy workspace manifests first to maximise layer caching on
# dependency-only changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/storage-memory/package.json packages/storage-memory/
COPY packages/storage-mongo/package.json packages/storage-mongo/
COPY packages/storage-postgres/package.json packages/storage-postgres/

RUN pnpm install --frozen-lockfile --filter "@dokhna-tech/zatca-server..." --prod=false

# Copy sources for every workspace package the server depends on.
COPY tsconfig.base.json tsconfig.json ./
COPY packages/core packages/core
COPY packages/server packages/server
COPY packages/storage-memory packages/storage-memory
COPY packages/storage-mongo packages/storage-mongo
COPY packages/storage-postgres packages/storage-postgres

RUN pnpm --filter "@dokhna-tech/zatca-server..." build

# Prune dev dependencies for the runtime image.
RUN pnpm --filter "@dokhna-tech/zatca-server" deploy --prod /out

############ Stage 2 — runtime ############
FROM node:20-slim AS runtime

# OpenSSL CLI is required by the onboarding flow (CSR + keygen probe).
# tini is PID 1 for clean signal handling.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Non-root user.
RUN groupadd --gid 10001 zatca \
  && useradd --uid 10001 --gid zatca --shell /bin/sh --create-home zatca

WORKDIR /app
COPY --from=build --chown=zatca:zatca /out /app

USER zatca

EXPOSE 3000

# Default health check via /healthz. LO-13: honour an
# operator-supplied `ZATCA_SERVER_PORT` rather than hardcoding 3000 —
# otherwise overriding the bind port silently breaks the probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.ZATCA_SERVER_PORT || 3000) + '/healthz').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/dist/cli.js"]
