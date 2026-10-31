# Private browser connector: a real, headed Chromium (not headless, which bot checks flag) on a
# virtual screen, served over HTTP on the Compose network. Pinned to one exact Playwright release so
# the browser binaries baked into the image always match the playwright-core driver in package.json;
# bump both together, and the digest with them. Keep this current: the browser reads hostile pages, so
# a Chromium more than one release behind is a known-exploit risk. Update at least monthly, and at once
# for a Chromium security release (see README.md, "Keeping the browser current").
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

COPY src ./src

# Each person's profile (cookies, local storage, saved logins) lives under here on a named volume,
# owned by the image's built-in unprivileged user. Nothing else reads this folder.
RUN mkdir /profiles && chown pwuser:pwuser /profiles
USER pwuser

EXPOSE 8792

# xvfb-run gives Chromium a real, virtual X display so it can run headed without a physical screen.
CMD ["xvfb-run", "--auto-servernum", "node", "/app/src/entrypoint.mjs"]
