# Private CalDAV connector: supergateway turns the stdio @ni-c/caldav-mcp server into HTTP.
# Reached only over the Compose network; nothing is published to the host.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

# The node user is built into the base image; the sidecar needs no root.
USER node

EXPOSE 9558

# Tool names and calendar credentials come from the Compose service, never from this image.
CMD ["node", "/app/node_modules/supergateway/dist/index.js", "--stdio", "node /app/node_modules/@ni-c/caldav-mcp/dist/index.js", "--outputTransport", "streamableHttp", "--host", "0.0.0.0", "--port", "9558", "--streamableHttpPath", "/mcp", "--logLevel", "warn"]
