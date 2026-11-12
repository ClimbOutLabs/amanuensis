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
  `http://browser-relay:8792`. The relay listens only on the server's network, and the proxy only on
  the browser's. The relay checks the shared secret (`BROWSER_SECRET`) and does not pass it on, so the
  browser's container never holds it. The sidecar answers only calls that arrive from the gateway.
- Chromium runs with its sandbox on, with a stripped environment, in a container with no
  capabilities, no privilege gain and a read-only root.
- Each chat has its own tab, and only sees the page it opened. Only opening a page makes a tab. A person
  keeps at most eight tabs; opening a ninth closes the one used longest ago, and a chat with no tab is
  told to open its page again.
- A page cannot move its tab to another site, open windows, or run service workers. Each redirect of
  the tab is checked as its response arrives, and one to another site is refused. A site's own `www.`
  name and a move from http to https count as the same site. When the tab is on another site (after
  going back in history), nothing of it is returned: the model is told the address and must open it,
  which the app server checks like any other open.

This is a separate browser, with its own logins. It is not the person's own Chrome.

## Routes

Every request goes through the relay with the `X-Browser-Secret` header, matching `BROWSER_SECRET`,
and names the person's profile (`owner`) and the chat's tab (`tab`).

- `POST /open { owner, tab, url }` — opens a page, refusing anything but `http`/`https` and anything
  on this computer or a private network, then returns a read.
- `POST /read { owner, tab }` — the page as text, in reading order: its title, its address, its
  headings and text, and its controls, each actionable one with a short ref (`e14`). A password,
  payment or one-time-code field never shows its value. Each read says where the view is, in pixels
  down the page (or the inner box that scrolls). A page too long for one read starts where the view
  is, keeps its main heading and short alerts, and says that the part above it is left out.
- `POST /scroll { owner, tab, direction }`, `POST /back { owner, tab }` — move around, then return a
  read.
- `POST /screenshot { owner, tab }` — a PNG of the page, which the app shows to the person in the chat.
  With it come `model_png_base64` and `text`. The first is the same picture with every password, card
  or one-time-code field (shadow roots included) and every embedded frame covered, and a red box and
  its ref on each control in view. The second is the page text from the same moment. The copy is
  drawn in a worker, never in the page, from a layout read in an isolated world, and is left out when
  it cannot be made safely.

A step that fails answers 500 with a fixed `reason` (`timeout`, `navigation_failed`, `page_changed`,
`page_script_error` or `unknown`), never the error's own text; the full error goes to the sidecar's log.

- `POST /click-info`, `POST /click`, `POST /type`, `POST /select { owner, tab, ref, ... }` — act on a
  control by its ref. The app server asks the person first for a click that would submit something.

The live view, where the person drives their own tab by hand from the app's `/browser-live` page:

- `POST /live/tabs { owner }` — the person's open tabs, most recent first, as chat id, title and
  address. It never starts a browser.
- `POST /live/frame { owner, tab }`: one JPEG frame of the tab and the viewport size, with
  `takeover` (whether the person holds the tab) and `challenge` (whether the page is showing a
  human check: the check's own frame is on the page, or the page is the full-page check).
- `POST /live/input { owner, tab, kind, ... }`: one act: `click` (x, y and the frame size it was read
  from), the takeover pointer acts `move`, `down` and `up` (a point, like a click), `type` (text),
  `key` (one named key) or `wheel` (dy). A click uses the real mouse, so the same
  rules keep the tab on its site. Acts on one tab run one at a time, in the order they arrived.
- `POST /live/takeover { owner, tab, on }`: hands the tab to the person, or back to the model. The
  tab never leaves the browser; only whose hand drives it changes. While a tab is taken over, the
  model's own steps on it (`/open`, `/scroll`, `/back`, `/click`, `/type`, `/select`) answer
  `refused` with reason `takeover`, and a streamed `move` is applied in steps from where the
  pointer last was, so the page sees a hand travelling rather than a pointer appearing.
- `POST /live/upload { owner, tab, name, mime, data }` — a file, base64, at most 10 MB, put into the
  file picker the page opened (dropped once the page moves on), or else its first file field. The
  page itself sends it.

The app server calls the live routes only for the signed-in person's own profile.

## Running it

The installer turns the browser on in every instance. Installing or upgrading builds both images, makes
`BROWSER_SECRET` once in the instance's `.env`, and starts the browser and its gateway with the instance.

For development from this repository, set `BROWSER_ENABLED=true` in `packages/trueforge/.env`, then start the stack with the browser profile.
Compose gives the server `BROWSER_URL=http://browser-relay:8792` and the same `BROWSER_SECRET` as the
gateway. `pnpm smoke` makes a random secret for each run. With plain `docker compose`, set one in the
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
