# syntax=docker/dockerfile:1
#
# Production image: installs published @truefoundry/trueforge from npm.
# The app bits match the npm package exactly (not floating monorepo source).
#
# Required build-arg:
#   APP_VERSION — npm version to install, e.g. 0.1.0
#
# Example:
#   docker build --build-arg APP_VERSION=0.1.0 -t aman:1.0.0 .

FROM node:24-slim AS runner
WORKDIR /app
# HOST=0.0.0.0 so Kubernetes Service/probe traffic reaches the process.
ENV NODE_ENV=production \
    STANDALONE=false \
    HOST=0.0.0.0

ARG APP_VERSION
RUN test -n "$APP_VERSION" || (echo "APP_VERSION build-arg is required" >&2 && exit 1)

# Fail closed if the version is not on the registry (no workspace fallback).
RUN npm install --omit=dev "@truefoundry/trueforge@${APP_VERSION}" \
  && npm cache clean --force

# Source reference this image was built from. The server reports it on
# GET /api/v1/capabilities and the UI shows it, so a released deployment can say which build it is.
# The release workflow passes the commit SHA; an omitted arg leaves it blank and the server reports
# the build as unstamped. Declared after the install so a restamp invalidates no layer above it.
ARG BUILD_REF=""
ENV BUILD_REF=${BUILD_REF}

RUN groupadd --gid 10001 trueforge \
  && useradd --uid 10001 --gid trueforge --shell /usr/sbin/nologin trueforge

# Writable data roots for the unprivileged runtime user. Deployments mount
# persistent volumes here (compose: memory-data -> /data/memory,
# persona-knowledge-data -> /data/persona-knowledge); creating them in the
# image lets the server start and run on deploy paths that mount nothing, and
# gives mounted volumes the right ownership when Docker initializes them from
# the image. Without a mounted volume this storage is ephemeral: anything
# written here is lost when the container is recreated, so real deployments
# must still mount persistent volumes. Without these dirs, the cwd-relative
# storage defaults resolve under the root-owned workdir and die with EACCES at
# first write.
RUN mkdir -p /data/memory /data/persona-knowledge \
  && chown -R 10001:10001 /data

# Image-level defaults so either image works without deploy-specific env: the
# data roots above are writable by the runtime user. Deploys that pin their own
# values (compose, runbook templates) override these.
ENV MEMORY_MARKDOWN_DIR=/data/memory \
  PERSONA_KNOWLEDGE_DIR=/data/persona-knowledge

EXPOSE 8790

# Same entry as the from-source image / `pnpm start` (launch-only; dist is in the package).
USER 10001:10001
CMD ["node", "node_modules/@truefoundry/trueforge/dist/main.js"]
