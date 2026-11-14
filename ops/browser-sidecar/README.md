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

- `POST /element-info { owner, tab, ref }` — reads one element without touching it: the site, the
  name a person sees on it, its role, whether it submits a form, the form's values (sensitive ones
  masked), and the address when it is a plain link. The app decides from this read whether an action
  asks first, and sends it back as `expect` with the action.
- `POST /type { owner, tab, ref, expect, text }` — types into a field, then returns a read. A password,
  payment or one-time-code field is refused; the person types those themselves.
- `POST /select { owner, tab, ref, expect, option }` — picks an option on a dropdown, then returns a read.
- `POST /click { owner, tab, ref, expect }` — clicks, then returns a read.

An action whose element no longer reads the way `expect` says is refused as `changed`, and the element
is not touched. One without `expect` is refused as `unchecked`. A disabled element is refused as
`disabled`, a read-only field as `read_only`, and an element that something else covers as `covered`. The app and the sidecar are built and
upgraded together, so the app always sends it.

The live view, where the person drives their own tab by hand from the app's `/browser-live` page:

- `POST /live/tabs { owner }` — the person's open tabs, most recent first, as chat id, title and
  address. It never starts a browser.
- `POST /live/frame { owner, tab }`: one JPEG frame of the tab and the viewport size, with
  `takeover` (whether the person holds the tab) and `challenge` (whether the page is showing a
  human check: the check's own frame is on the page, or the page is the full-page check).
- `POST /live/input { owner, tab, kind, ... }`: one act: `click` (x, y and the frame size it was read
  from), the takeover pointer acts `move`, `down` and `up` (a point, like a click), `type` (text),
  `paste` (text put in as one insert, as a real paste is, so a line break never presses Enter),
  `key` (one named key) or `wheel` (dy). A click uses the real mouse, so the same
  rules keep the tab on its site. Acts on one tab run one at a time, in the order they arrived.
- `POST /live/takeover { owner, tab, on }`: hands the tab to the person, or back to the model. The
  tab never leaves the browser; only whose hand drives it changes. While a tab is taken over, the
  model's own steps on it (`/open`, `/scroll`, `/back`, `/click`, `/type`, `/select`) answer
  `refused` with reason `takeover`, and a streamed `move` is applied in steps from where the
  pointer last was, so the page sees a hand travelling rather than a pointer appearing.
- `POST /live/copy { owner, tab }`: the text the person selected in the tab, for copying to their
  own clipboard: the selected part of the focused field, or else the page's selection, from the
  focused frame first. Answers `nothing_selected`, or `password` for a password field, whose text is
  never read out. The text is never logged or kept.
- `POST /live/close { owner, tab }`: closes the tab when the person ends the session. The chat then
  has no page, so the model's next step on it answers `closed` until it opens a page again.
- `POST /live/upload { owner, tab, name, mime, data }` — a file, base64, at most 10 MB, put into the
  file picker the page opened (dropped once the page moves on), or else its first file field. The
  page itself sends it.

The app server calls the live routes only for the signed-in person's own profile.

## Reading and acting on a page

The sidecar reads pages in a script world of its own, beside the page's. The page's own scripts can
change what the DOM's functions and properties return in their world, but not in this one, so what the
sidecar reads is what the browser holds. Every read of an element and every action on it runs there.

An action checks its element against `expect` and acts on it in the same step, with no gap in which
the page could swap the element. A click on a button is a real mouse press at the element's middle.
The point is checked to land on the element, then checked again once the pointer is there, because a
page can move things when the pointer arrives. Typing is real keystrokes into the field, focused in
the same step. What was in the field is selected with a real key press first, so the keystrokes
replace it. A one-line field refuses text with a line break or tab as `line_break`, because those keys
would press Enter or Tab and could send the form. In a multi-line field, line breaks and tabs are
inserted as text, so no key is pressed for them. Any other character that is not plain text is refused as
`control_character`. Picking sets the option the way a person's choice
does, so the page's own code sees the change.

While a press or typing runs, two guards watch the input. One is in the sidecar's world in the page,
set up at the start of every document, before any of the page's scripts. It stops any real input that
lands outside the checked element, and it notices when a press never reached the element or typing
ended with the focus somewhere else. The other runs first in every frame inside the page, including
frames from other sites. Aman never acts inside a frame, so it stops all real input that reaches one.
Either way the action is refused as `changed`. The frame guard is switched off only while one of the
person's own live-view clicks or keys runs, so they can use a human check or a card form inside a frame
by hand. A page's scripts cannot switch it off: the key it answers to is never in any script the
page can read, and the sidecar hands it over only through the browser's debugging channel. If any
frame on the page cannot be checked to have its guard on, Aman's input is refused as `unchecked`. The person's acts and Aman's own input take turns on a
tab, so the frame guard is always on while Aman's input runs. A guard that could only be set up after the page's
scripts ran is not trusted, so the action is refused as `unchecked`.

The fields an action checks are the ones that decide what it does: a click checks them all,
and typing or picking checks the site, the name and the role, since earlier typing changes the form.

## Which actions ask first

A click asks the person first unless it is a plain link to another page: an `<a>` or `<area>` with an
`http` or `https` address the browser would follow with an ordinary page load. The sidecar does not
press such a link. It opens the link's address, so none of the page's scripts run for it, the same as
opening the address directly. A link to another site is not followed; the app is told its address,
and opening it is checked like any other open. Like an open, a link only reads a page, so a site that
changes something on a plain page load (for example, cancelling an order at a link's address) does it
without a card, as it would for an open.

A button, a tab, a menu, a link to a spot on the same page, a `javascript:` link and a link marked as a
button all run the page's own script, which decides what is sent whatever the label says, so every one
of them asks. A link asks too when its label is a word like pay, buy, send or delete. That word list
only ever makes a click ask; it never lets one through. A name is read the way a person sees it: an
icon-only button is named by its image's alt text or label, and characters that show nothing
(zero-width spaces, soft hyphens) are left out.

Typing and picking an option always ask first, with the exact text or option, the field and the site
on the card. A page can send what is typed the moment it changes, by any route, so the sidecar does
not try to hold it back afterwards.

In a scheduled run nobody is there to answer, so actions that ask are saved for the person to approve
later. A click that comes after typing or picking that is still waiting is not saved: its card would
show the form as it is now, not as the approved typing leaves it. The model is told to click again
once the person approves.

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

`pnpm test:cobrowse` runs the whole live-view check in one go, with made-up local sites only. It runs:

- the sidecar tests above, which need Docker
- the live browser page in a real Chromium against a stand-in server
- the reply loop tests that keep browser steps from being skipped as already done

It exits 0 only when every part passes.
