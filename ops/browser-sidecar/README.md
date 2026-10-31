# Browser sidecar

Aman's own web browser: a real, headed Chromium running under Xvfb (a virtual screen), with one
persistent profile per person so logins survive restarts. It is never published to the host.

## How it is walled off

The browser reads hostile pages, so it shares a network with nothing of Aman's.

- The `browser` container's only network is internal (no route out) and holds just `browser-gateway`.
- Chromium sends every request through the gateway's egress proxy (`src/egressProxy.mjs`): the first
  page, redirects, the page's own requests, form posts and WebSocket tunnels. The proxy resolves each
  host once, refuses anything on this computer or a private network (loopback, RFC 1918, link-local
  and cloud metadata, carrier NAT, IPv6 private and tunnel prefixes), and connects to the address it
  checked, so a name cannot change its answer in between.
- The app server reaches the sidecar's API only through the gateway's relay, at
  `http://browser-gateway:8792`, on a network the browser is not on.
- Chromium runs with its sandbox on, without the shared secret in its environment, in a container
  with no capabilities, no privilege gain and a read-only root.
- A page cannot move its tab to another site, open windows, or run service workers. When the tab
  ends up on a site other than the one opened (a redirect, or going back), nothing of it is returned:
  the model is told the address and must open it, which the app server checks like any other open.

This is a separate browser, with its own logins. It is not the person's own Chrome.

## Routes

Every request needs the `X-Browser-Secret` header, matching `BROWSER_SECRET`.

- `POST /open { owner, url }` — opens a page, refusing anything but `http`/`https` and anything on
  this computer or a private network, then returns a read.
- `POST /read { owner }` — the current page as text: its title, its address, and its visible,
  interactive elements, each with a short ref (`e14`) for the tools that act on one. A password,
  payment or one-time-code field never shows its value.
- `POST /scroll { owner, direction }`, `POST /back { owner }` — move around, then return a read.
- `POST /screenshot { owner }` — a PNG of the page, for the receipt and for the person to look at.
- `POST /type { owner, ref, text }` — types into a field; refuses a password, card or one-time-code
  field instead of typing into it.
- `POST /select { owner, ref, option }` — picks an option on a dropdown.
- `POST /click-info { owner, ref }` — reads a clicked element's site, accessible name, form-submit-
  ness and form values, without clicking it. Used to decide whether the click needs the person's OK.
- `POST /click { owner, ref, approved }` — clicks an element. `approved: true` is trusted outright
  (the server only sets it once the person has said OK). Otherwise the request gate runs: any
  same-site, non-`GET` request the click sets off (a form post, a fetch that sends data) is aborted,
  and the click comes back as `needs_approval` instead of succeeding — catching a click the Tier
  classifier found no commit word on, but that quietly submits something anyway. A third-party
  request (an analytics beacon, a widget on another domain) is never blocked, only logged.

## Running it

`docker compose --profile browser up --build browser browser-gateway` after setting `BROWSER_ENABLED=true`,
`BROWSER_URL=http://browser-gateway:8792` and a random `BROWSER_SECRET` (32+ characters, for example from
`openssl rand -hex 32`) in `packages/trueforge/.env`.

## Keeping the browser current

The image and `playwright-core` are pinned to one Playwright release, with the image's digest.
Bump all three together at least monthly, and at once when a Chromium security release fixes a bug
exploited in the wild.

## Tests

`npm test` runs the URL safety rules, the egress proxy, the snapshot text builder, and (where a
Chromium for this Playwright release is installed) fixture pages in a real browser that go through
the real egress proxy, with only DNS and the final TCP connect stood in for.
