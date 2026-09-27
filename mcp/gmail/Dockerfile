# Gmail MCP server — standalone image (pnpm).
#
# Build context: mcp/gmail
#   docker build -t gmail-mcp:pr287 mcp/gmail
#
# The package ships its own pnpm-lock.yaml + pnpm-workspace.yaml (the latter
# carries the google-auth-library override the root workspace also applies,
# so the image resolves exactly one 10.x and typechecks like the monorepo).
# Default command serves Streamable HTTP on 0.0.0.0:8080; override the command
# with `mcp` for stdio.

FROM node:24-slim AS build
RUN corepack enable && corepack prepare pnpm@11.16.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
# pnpm 11 refuses pre-run installs when a build script was ignored
# (esbuild's postinstall); deps are already installed, so skip the check.
RUN pnpm --config.verify-deps-before-run=false run build
# Prune devDependencies for the runtime image.
RUN pnpm install --frozen-lockfile --prod

FROM node:24-slim AS runtime
ENV NODE_ENV=production
# Config/state live here; mount a volume to persist credentials across restarts.
ENV GMAIL_CONFIG_DIR=/gmail-server
RUN groupadd -r --gid 10000 gmail && useradd -r --uid 10000 --gid 10000 \
      --create-home --home-dir /home/gmail --shell /usr/sbin/nologin gmail \
    && mkdir -p /gmail-server /app \
    && chown -R 10000:10000 /gmail-server /app /home/gmail
WORKDIR /app
COPY --from=build --chown=10000:10000 /app/dist ./dist
COPY --from=build --chown=10000:10000 /app/node_modules ./node_modules
COPY --from=build --chown=10000:10000 /app/package.json ./package.json
USER 10000:10000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
# GMAIL_HTTP_TOKEN is REQUIRED for the HTTP transport — startup fails closed
# without it. Set -e GMAIL_HTTP_TOKEN=... and -v <dir>:/gmail-server.
CMD ["node", "dist/cli/index.js", "mcp", "--http", "--bind=0.0.0.0", "--port=8080"]
