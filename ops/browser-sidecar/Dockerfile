# Private browser connector: a real, headed Chromium (not headless, which bot checks flag) on a
# virtual screen, served over HTTP on the Compose network. Pinned to one exact Playwright release so
# the browser binaries baked into the image always match the playwright-core driver in package.json;
# bump both together.
FROM mcr.microsoft.com/playwright:v1.49.1-noble

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
