# Private CalDAV connector: supergateway turns the stdio @ni-c/caldav-mcp server into HTTP.
# Reached only over the Compose network; nothing is published to the host.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

# The account agent and the supervisor that starts the tool server while an account is saved.
COPY account.mjs signin.mjs agent.mjs entrypoint.mjs ./

# The account folder is made here, owned by the node user, so the volume Compose mounts on it starts
# out owned by the sidecar and by nobody else. The node user is built into the base image; no root.
RUN mkdir /account && chown node:node /account
USER node

EXPOSE 9558 9560

# Tool names come from the Compose service. The calendar login is read from the account file in the
# sidecar's own volume, never from this image or from the service's environment.
CMD ["node", "/app/entrypoint.mjs"]
