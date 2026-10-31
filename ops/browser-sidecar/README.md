# Browser sidecar

Aman's own web browser: a real, headed Chromium running under Xvfb (a virtual screen), with one
persistent profile per person so logins survive restarts. It is private to the Compose network —
reached only by the app server, at `http://browser:8792` — and never published to the host.

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

Clicking, typing and the approval gate for actions that submit something are a later change (Phase 2
of the browser control feature).

## Running it

`docker compose --profile browser up --build browser` after setting `BROWSER_ENABLED=true`,
`BROWSER_URL=http://browser:8792` and a random `BROWSER_SECRET` (32+ characters, for example from
`openssl rand -hex 32`) in `packages/trueforge/.env`.

## Tests

`npm test` runs the parts that need no browser and no network: the URL safety rules and the
snapshot text builder. A fixture-page test against a real Chromium is exercised separately, where
Playwright's browsers are installed.
