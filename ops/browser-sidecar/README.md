# Browser sidecar

Aman's own web browser: a real, headed Chromium running under Xvfb (a virtual screen), with one
persistent profile per person so logins survive restarts, and one tab per chat inside it. It is never
published to the host.

## How it is walled off

The browser reads hostile pages, so it shares a network with nothing of Aman's.

- The `browser` container's only network is internal (no route out) and holds just `browser-gateway`.
- Chromium sends every request through the gateway's egress proxy (`src/egressProxy.mjs`): the first
  page, redirects, the page's own requests, form posts and WebSocket tunnels. The proxy resolves each
  host once, refuses anything on this computer or a private network (loopback, RFC 1918, link-local
  and cloud metadata, carrier NAT, IPv6 private and tunnel prefixes), and connects to the address it
  checked, so a name cannot change its answer in between. The gateway is the only part that looks up
  names; the sidecar asks it (`GET /check`) before it opens a page, so the model gets a plain refusal.
- The app server reaches the sidecar's API only through the gateway's relay, at
  `http://browser-gateway:8792`, on a network the browser is not on. The API answers only calls that
  arrive from the gateway, so nothing inside the browser container can use it, even with the secret.
- Chromium runs with its sandbox on, without the shared secret in its environment, in a container
  with no capabilities, no privilege gain and a read-only root.
- Each chat has its own tab, and only sees the page it opened. A person keeps at most eight tabs;
  opening a ninth closes the one used longest ago.
- A page cannot move its tab to another site, open windows, or run service workers. Redirects are
  followed one hop at a time, and a hop to another site is refused. When the tab ends up on a site
  other than the one opened (a redirect, or going back), nothing of it is returned: the model is told
  the address and must open it, which the app server checks like any other open.

This is a separate browser, with its own logins. It is not the person's own Chrome.

## Routes

Every request needs the `X-Browser-Secret` header, matching `BROWSER_SECRET`, and names the person's
profile (`owner`) and the chat's tab (`tab`).

- `POST /open { owner, tab, url }` — opens a page, refusing anything but `http`/`https` and anything
  on this computer or a private network, then returns a read.
- `POST /read { owner, tab }` — the page as text, in reading order: its title, its address, its
  headings and text, and its controls, each actionable one with a short ref (`e14`). A password,
  payment or one-time-code field never shows its value.
- `POST /scroll { owner, tab, direction }`, `POST /back { owner, tab }` — move around, then return a
  read.
- `POST /screenshot { owner, tab }` — a PNG of the page, which the app shows to the person in the chat.

Clicking, typing and the approval gate for actions that submit something are a later change (Phase 2
of the browser control feature).

## Running it

Set `BROWSER_ENABLED=true` in `packages/trueforge/.env`, then start the stack with the browser profile.
Compose gives the server `BROWSER_URL=http://browser-gateway:8792` and the same `BROWSER_SECRET` as the
browser. `pnpm smoke` makes a random secret for each run. With plain `docker compose`, set one in the
shell first (32 or more characters, for example from `openssl rand -hex 32`):

```sh
export BROWSER_SECRET=$(openssl rand -hex 32)
docker compose --profile browser up --build
```

## Keeping the browser current

The image and `playwright-core` are pinned to one Playwright release, with the image's digest.
Bump all three together at least monthly, and at once when a Chromium security release fixes a bug
exploited in the wild.

## Tests

`pnpm test:browser-sidecar` (from the repository root, and in CI) builds the image and runs every test
inside it, with the same sandbox settings Compose uses: the URL safety rules, the egress proxy, the
snapshot text builder, and fixture pages in a real browser that go through the real egress proxy, with
only DNS and the final TCP connect stood in for. `npm test` here runs the same tests, and skips the
browser ones where no Chromium for this Playwright release is installed.
