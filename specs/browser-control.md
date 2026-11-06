# Spec: Browser Control

**Status:** approved

## Problem

Some things a person asks Aman to do live only on a website: checking an account page, finding a setting, reading a page that needs a login. Search and page fetches cannot reach a page behind a login, and they cannot move around a site. Aman needs a browser of its own that can stay signed in to the person's sites, without giving those pages any way to reach Aman, the person's network, or other people's data.

## Solution

Aman gets its own real browser, separate from the person's own Chrome. It runs in a walled-off container next to Aman's server and keeps one browser profile per person, so logins survive restarts. Each chat gets its own tab in that profile.

The work lands in phases, each its own PR that links this spec:

1. **Read-only browser.** Open a page, read it as text, scroll, go back, and take a screenshot for the person. Nothing is typed or submitted.
2. **Acting on a page.** Typing and clicking. Any click that submits something asks the person first, with an approval card that shows what will be sent.
3. **Receipts.** A record of what Aman did in the browser, with a screenshot, that the person can look back at.

Alongside these, a **live view** lets the person finish a step only they can do. Some pages need the person: a sign-in, a code sent to their phone, a picture check, or a cookie banner Aman cannot clear. The person opens Aman's live browser at `/browser-live` in Aman's own app, picks the tab, and sees it about twice a second. They click, scroll, type and upload a file into it, in the order they did it. Then they press Done and tell Aman in the chat that they are finished, since the turn that sent them there has ended. What they did stays in their browser profile for Aman's next read, so a sign-in they finish keeps working. When a page needs such a step, the model tells the person to open the live view.

## Key design decisions

- **A real, headed Chromium.** Headless browsers are flagged by many sites' bot checks. The browser runs on a virtual screen inside its container.
- **Walled off by the network.** The browser's container shares a network only with a small gateway. Every request the browser makes goes through the gateway's proxy, which refuses anything on the computer itself or a private network, including cloud metadata addresses. It checks each address once and connects to the address it checked. The server reaches the browser only through the gateway, which checks a shared secret. The browser's container never holds that secret.
- **A hardened container.** Chromium's own sandbox stays on. The container has no extra privileges and a read-only root. The browser image is pinned and kept current.
- **One tab per chat.** A chat sees only the page it opened. A person keeps a limited number of tabs. When the oldest closes to make room, that chat is told to open its page again.
- **Pages stay on their site.** A page cannot move its tab to another site, open windows, or redirect off the site it was opened on. A site's own `www.` name and a move from http to https count as the same site. When a tab ends up on another site, nothing of that page is returned. The model must open the new address, which is checked like any other open.
- **Opening an address is checked like a lookup.** The address is sent to a site, so it gets the same checks as a search or page fetch:
  - keys the server holds are masked
  - the person's search setting is respected
  - the lookup limit applies
  - Aman asks first when only content it read named the link
  - Aman asks first when the link carries a private detail
  - Aman asks first, after reading other people's content, when the person did not give the address
  - in scheduled runs, these cases are skipped instead of asked
- **Browser pages are the person's.** A page read in the signed-in browser is treated like the person's mail: their details in it count as private.
- **Screenshots go to the person.** The model never sees the picture.
- **The live view is the person's own hands, and only theirs.** Its routes on the app server take only the signed-in person's browser session, never an agent or API token, and always use that person's own profile; a request cannot name another profile. The server calls the browser through the same gateway with the shared secret, so the secret never reaches the page. The tab still cannot leave its site: a click goes through the real mouse, and the same rules refuse any move to another site. Nothing the person does in the live view goes through an approval card, because the person is the one doing it. A file upload is at most 10 MB and lands only in the file picker the page opened, or else its first file field; the page itself sends it.
- **On in every installed Aman.** Installing or upgrading with the installer builds the browser, makes the secret the server and the gateway share, and starts both with the instance. Nobody edits a settings file or exports a secret. Running the code directly (development) keeps it off unless the server turns it on and Compose runs the `browser` profile.

## Scope

In scope: the browser container and gateway, the browser tools, their permission rules, configuration, Compose wiring, documentation and tests for the three phases above.

## Privacy

- **What data is involved:** the pages the browser opens and the person's logins, which live in their browser profile on a local Docker volume.
- **Where it flows:**
  - Page text goes to the model, like a fetched page.
  - Screenshots stay in the chat for the person.
  - Live view frames, clicks, typing and uploaded files go only between the person's own app page, Aman's server and the browser. The model does not see them. A file goes to a site only when the page sends it.
  - Logins and cookies are stored only in the person's browser profile, on a volume only the browser's container mounts.
  - The addresses Aman opens go to those sites, under the checks above.
- **What stays on the device:** the profiles, the browser, the gateway and every page Aman reads. Nothing goes to a third-party service other than the sites themselves and the model provider.
- **Password, payment and one-time-code fields never show their values in the page text.**

## Testing

Tests use synthetic data only: fixture web pages served locally and made-up site names. They never use a person's real accounts or pages.

- The sidecar's tests run inside the real browser image with the same sandbox settings, from a package script and in CI. They cover:
  - the address rules and the egress proxy
  - page text
  - real-browser fixtures for redirects, a page's own requests, popups, per-chat tabs and large pages
- The permission tests cover the open checks, and the capability tests cover the requests the server sends and the replies it accepts.
- The live view's tests cover the sidecar routes with a stand-in page, the app server routes (sign-in required, the person's own profile only, size limits), and the page itself in a real browser against a stand-in server: the tabs, frames, clicks in frame pixels, typing in order, uploads and their errors, and Done. The live routes refuse a form posted from another site and an agent or API token.
- The Compose tests check the network wall.

## Out of scope

- Using the person's own Chrome.
- Saved passwords and automatic sign-in. A later spec covers how logins are kept.
- Video sites that need DRM.
- Native installers.
