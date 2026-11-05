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
  payment or one-time-code field never shows its value.
- `POST /scroll { owner, tab, direction }`, `POST /back { owner, tab }` — move around, then return a
  read.
- `POST /screenshot { owner, tab }` — a PNG of the page, which the app shows to the person in the chat.
- `POST /type { owner, tab, ref, text }` — types into a field, then returns a read. A password, payment
  or one-time-code field is refused; the person types those themselves.
- `POST /select { owner, tab, ref, option }` — picks an option on a dropdown, then returns a read.
- `POST /click-info { owner, tab, ref }` — reads one element without touching it: the site, the name a
  person sees on it, whether it submits a form, the form's values (sensitive ones masked), and the
  address when it is a plain link. The app decides from this read whether the click asks first.
- `POST /click { owner, tab, ref, expect }` — clicks, then returns a read. `expect` is the
  `/click-info` read the click was checked against. The click goes ahead only while the element at the
  ref still reads exactly that way; otherwise it is refused as `changed`, and nothing is pressed.

## Clicks

A click asks the person first unless it is a plain link to another page: an `<a>` or `<area>` with an
`http` or `https` address the browser follows with an ordinary page load. A button, a tab, a menu, a
link to a spot on the same page, a `javascript:` link and a link marked as a button all run the page's
own script, which can send anything whatever the label says, so every one of them asks. A link asks
too when it submits a form or its label is a word like pay, buy, send or delete. That word list only
ever makes a click ask; it never lets one through.

A name is read the way a person sees it: an icon-only button is named by its image's alt text or
label, and characters that show nothing (zero-width spaces, soft hyphens) are left out.

All the calls of one reply are checked before the first one runs, and refs restart on every new page.
So a later click in a reply may find a different element at its ref than the one it was checked
against. The `expect` read is how the sidecar catches that: it reads the very element it is about to
press and compares it with `expect`, field by field, in one place (`sameClickReview`).

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
