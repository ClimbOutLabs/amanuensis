# Tasks MCP server — standalone image (pnpm).
#
# Build context: mcp/tasks
#   docker build -t tasks-mcp:1.0.0 mcp/tasks
#
# Default command serves Streamable HTTP on 0.0.0.0:8080; run with plain
# `mcp` for stdio.

FROM node:24-slim AS build
RUN corepack enable && corepack prepare pnpm@11.16.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build
# Prune devDependencies for the runtime image.
RUN pnpm install --frozen-lockfile --prod

FROM node:24-slim AS runtime
ENV NODE_ENV=production
# Config/state live here; mount a volume to persist credentials across restarts.
ENV TASKS_CONFIG_DIR=/tasks-server
RUN groupadd -r --gid 10000 tasks && useradd -r --uid 10000 --gid 10000 \
      --create-home --home-dir /home/tasks --shell /usr/sbin/nologin tasks \
    && mkdir -p /tasks-server /app \
    && chown -R 10000:10000 /tasks-server /app /home/tasks
WORKDIR /app
COPY --from=build --chown=10000:10000 /app/dist ./dist
COPY --from=build --chown=10000:10000 /app/node_modules ./node_modules
COPY --from=build --chown=10000:10000 /app/package.json ./package.json
USER 10000:10000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
# No static token is needed for the HTTP transport: the MCP client forwards
# its Google OAuth access token as the bearer token, validated per request.
CMD ["node", "dist/index.js", "mcp", "--http", "--port=8080"]
