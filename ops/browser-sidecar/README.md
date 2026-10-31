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

`docker compose --profile browser up --build browser` after setting `BROWSER_ENABLED=true`,
`BROWSER_URL=http://browser:8792` and a random `BROWSER_SECRET` (32+ characters, for example from
`openssl rand -hex 32`) in `packages/trueforge/.env`.

## Tests

`npm test` runs the parts that need no browser and no network: the URL safety rules and the
snapshot text builder. The fixture-page tests in `test/sidecar.test.mjs` need a real Chromium
(`npx playwright install chromium`, already present in the Docker image) and skip automatically
where one is not installed.
