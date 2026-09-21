# syntax=docker/dockerfile:1
#
# Production image: installs published @truefoundry/trueforge from npm.
# The app bits match the npm package exactly (not floating monorepo source).
#
# Required build-arg:
#   APP_VERSION — npm version to install, e.g. 0.1.0
#
# Example:
#   docker build --build-arg APP_VERSION=0.1.0 -t trueforge:0.1.0 .

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

EXPOSE 8790

# Same entry as the from-source image / `pnpm start` (launch-only; dist is in the package).
USER 10001:10001
CMD ["node", "node_modules/@truefoundry/trueforge/dist/main.js"]
