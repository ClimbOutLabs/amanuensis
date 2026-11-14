# Spec: Browser Control

**Status:** approved

## Problem

Some things a person asks Aman to do live only on a website: checking an account page, finding a setting, reading a page that needs a login. Search and page fetches cannot reach a page behind a login, and they cannot move around a site. Aman needs a browser of its own that can stay signed in to the person's sites, without giving those pages any way to reach Aman, the person's network, or other people's data.

## Solution

Aman gets its own real browser, separate from the person's own Chrome. It runs in a walled-off container next to Aman's server and keeps one browser profile per person, so logins survive restarts. Each chat gets its own tab in that profile.

The work lands in phases, each its own PR that links this spec:

1. **Read-only browser.** Open a page, read it as text, scroll, go back, and take a screenshot for the person. Nothing is typed or submitted.
2. **Acting on a page.** Typing and clicking. Any click that could send something asks the person first, with an approval card that shows what will be sent. Only a plain link to another page runs without asking, and Aman opens its address instead of pressing it, so the page's own scripts do not run; like any open, that only loads a page. A button, tab or menu runs the page's own script, which can send anything whatever its label says, so it always asks. Typing and picking an option ask first too, with the exact text on the card, because a page can send what is typed the moment it changes. Typing never presses Enter or Tab, and input that would land anywhere but the checked element, including a frame inside the page, is stopped. Every action runs only on the element that was checked, read where the page's scripts cannot change what Aman sees: if the page changed in between, the action is refused and Aman reads the page again.
3. **Receipts.** A record of what Aman did in the browser, with a screenshot, that the person can look back at.

Alongside these, a **live view** lets the person finish a step only they can do. Some pages need the person: a sign-in, a code sent to their phone, a picture check, or a cookie banner Aman cannot clear. The person opens Aman's live browser at `/browser-live` in Aman's own app, picks the tab, and sees it about twice a second. They click, scroll, type, paste and upload a file into it, in the order they did it, and copy text they select in it to their own clipboard. Pasted text, copied text and the name and password filled from their password manager go only between the person and the page: they are never logged, kept or shown to the model, and a password field's text is never copied out. Then they press Done and tell Aman in the chat that they are finished, since the turn that sent them there has ended. What they did stays in their browser profile for Aman's next read, so a sign-in they finish keeps working. When a page needs such a step, the model tells the person to open the live view.

## Key design decisions

- **A real, headed Chromium.** Headless browsers are flagged by many sites' bot checks. The browser runs on a virtual screen inside its container.
- **Walled off by the network.** The browser's container shares a network only with a small gateway. Every request the browser makes goes through the gateway's proxy, which refuses anything on the computer itself or a private network, including cloud metadata addresses. It checks each address once and connects to the address it checked. The server reaches the browser only through the gateway, which checks a shared secret. The browser's container never holds that secret.
- **A hardened container.** Chromium's own sandbox stays on. The container has no extra privileges and a read-only root. The browser image is pinned and kept current.
- **Moving around a page is not a repeat, going in circles is.** Aman stops a reply that repeats the exact same step with nothing changed in between. For the browser, opening, scrolling, going back, typing, picking and clicking are never answered from an earlier result. When one of them reaches a page not seen before in the reply, the same step may run again from there (to go further down a long page), and the page may be read again. A step that lands on a page already seen moved nothing new: scrolling at the bottom of a page, or going back and forth between two pages, is stopped like any other repeat. The same step that keeps reaching new pages still stops after eight times in a reply, so a page whose text changes on every read (a clock, a rotating ad) cannot keep it going. Only Aman's own browser counts; a connector tool with the same name does not. Reading an unchanged page twice in a row is still stopped.
- **A long page is read from where it is scrolled to.** A read shows about 8,000 tokens of a page. Each read says where the view is, in pixels down the page, and when it has reached the end, so a scroll that moved the view is a move even when the page's text fits one read. When the page is longer than one read, the read leaves out what is above the view and says so, so each scroll down shows the next part; the page's main heading and its short alerts always stay in, while a long live region such as a chat log scrolls like the rest. A scroll turns the wheel over the middle of the view, so a web app that scrolls an inner box scrolls too, and waits for the page to come to rest before reading it.
- **One tab per chat.** A chat sees only the page it opened. A person keeps a limited number of tabs. When the oldest closes to make room, that chat is told to open its page again.
- **Pages stay on their site.** A page cannot move its tab to another site, open windows, or redirect off the site it was opened on. A site's own `www.` name and a move from http to https count as the same site. When a tab ends up on another site, nothing of that page is returned. The model must open the new address, which is checked like any other open.
- **Opening an address is checked like a lookup.** The address is sent to a site, so it gets the same checks as a search or page fetch:
  - keys the server holds are masked
  - the person's search setting is respected
  - the lookup limit applies
  - Aman asks first when only content it read named the link
  - Aman asks first when the link carries a private detail
  - Aman asks first, after reading other people's content, when the person did not give the address
  - an address with a sign-in name or password in front of the site (`https://name@site/`) is never an address the person gave, a search returned or a page listed, whoever wrote it
  - the browser itself never opens an address with a sign-in name or password in front of the site, because it would hand them to the site; Aman says to ask for the address without that part
  - in scheduled runs, these cases are skipped instead of asked
- **Browser pages are the person's.** A page read in the signed-in browser is treated like the person's mail: their details in it count as private.
- **Screenshots go to the person, and to a model that reads images.** The person gets the plain picture in the chat. The model gets a copy with a red box and its ref on each control in view, so it can act on what it sees by ref instead of guessing a position.
  - The copy is drawn by the sidecar onto the picture, never into the page, so a page cannot see, hide or fake the labels, and both pictures share the same pixels. Where things sit is read in a script world of its own, which the page's scripts cannot hook or watch.
  - Every password, card and one-time-code field is covered in the model's copy, as the page text hides their values, including fields inside shadow roots. Every embedded frame is covered whole, because a hosted card form sits in a frame the page cannot read. A closed shadow root that holds a field is covered whole too. The page is looked at before and after the shot; if such a field appeared or moved in between, or the copy cannot be made, the model gets no picture and is told so.
  - The page text from the same moment is stored with the result, so what the picture showed is recorded like any page the chat read.
  - The model sees at most the three latest screenshots, each right after the result it came with, and they are never stored in the chat. The picture goes in as the host's message, marked as page content, so it never takes the place of the person's own message. A model that cannot read images is shown none.
- **The model can recover by itself.** When a chat's page has closed (Aman restarted, or the tab made room for another chat), the model is told to open the address it last opened again and carry on. It asks the person first only when opening that address does something by itself. A page that closes a second time in one turn is reported instead, so busy chats cannot keep closing each other's tabs. When a step fails, the model gets a fixed, plain reason (the page took too long, could not be loaded, changed, or its own code stopped the step), never the browser's error text, which a page can write.
- **The live view is the person's own hands, and only theirs.** Its routes on the app server take only the signed-in person's browser session, never an agent or API token, and always use that person's own profile; a request cannot name another profile. The server calls the browser through the same gateway with the shared secret, so the secret never reaches the page. The tab still cannot leave its site: a click goes through the real mouse, and the same rules refuse any move to another site. Nothing the person does in the live view goes through an approval card, because the person is the one doing it. A file upload is at most 10 MB and lands only in the file picker the page opened, or else its first file field; the page itself sends it.
- **On in every installed Aman.** Installing or upgrading with the installer builds the browser, makes the secret the server and the gateway share, and starts both with the instance. Nobody edits a settings file or exports a secret. Running the code directly (development) keeps it off unless the server turns it on and Compose runs the `browser` profile.

## Scope

In scope: the browser container and gateway, the browser tools, their permission rules, configuration, Compose wiring, documentation and tests for the three phases above.

## Privacy

- **What data is involved:** the pages the browser opens and the person's logins, which live in their browser profile on a local Docker volume.
- **Where it flows:**
  - Page text goes to the model, like a fetched page.
  - Screenshots stay in the chat for the person. A model that reads images also sees the latest few, with password, card and one-time-code fields covered, so they go to the model provider like the page text.
  - Live view frames, clicks, typing and uploaded files go only between the person's own app page, Aman's server and the browser. The model does not see them. A file goes to a site only when the page sends it.
  - Logins and cookies are stored only in the person's browser profile, on a volume only the browser's container mounts.
  - The addresses Aman opens go to those sites, under the checks above.
- **What stays on the device:** the profiles, the browser, the gateway and every page Aman reads. Nothing goes to a third-party service other than the sites themselves and the model provider.
- **Password, payment and one-time-code fields never show their values in the page text.** A field counts as one by its type, its autocomplete hint, or the words in its name in any naming style (`otp_code`, `otpCode`, `cvv`, a card's security code, a field named `pin`, `mpin`, `tpin` or a transaction PIN, a row of unlabelled one-digit boxes however each is wrapped). The same words count when they are in what the page calls the field: its label, its `aria-label` or its placeholder, so a field named `f1` under a "Card number" label is covered. A field named `pan` is a card field; a label that says "pan" is not enough, and a "PAN card number" label is India's tax ID, not a payment card. One named or labelled `card` alone is a card field when it takes only digits, so "Name on card" stays visible. One named or labelled `token` or `authcode` is a code when it holds ten characters or fewer, unless it is a promo, coupon, voucher or gift token. A label that says only "PIN" marks a code, except in a form that also asks for an address, where a box that can hold six digits is the postal code. A postal PIN code (`pincode`, `pin_code`, or a `pin` field marked as a postal code, India's postal code), a map pin, and labelled one-digit boxes such as a count of guests are not secrets and stay visible.

## Testing

Tests use synthetic data only: fixture web pages served locally and made-up site names. They never use a person's real accounts or pages.

- The sidecar's tests run inside the real browser image with the same sandbox settings, from a package script and in CI. They cover:
  - the address rules and the egress proxy
  - page text
  - real-browser fixtures for redirects, a page's own requests, popups, per-chat tabs and large pages
- The permission tests cover the open checks, and the capability tests cover the requests the server sends and the replies it accepts, where the model's screenshots go in the request, the limit of three, and the error and closed-page messages.
- Real-browser tests check that a screenshot gives a labelled copy, covers a card number the person's own picture still shows (plain, in a frame, in open and closed shadow roots, on a page that lies about its layout, and one-digit code boxes), and adds nothing to the page. Unit tests cover drawing the copy and the fixed failure reasons.
- The live view's tests cover the sidecar routes with a stand-in page, the app server routes (sign-in required, the person's own profile only, size limits), and the page itself in a real browser against a stand-in server: the tabs, frames, clicks in frame pixels, typing in order, uploads and their errors, and Done. The live routes refuse a form posted from another site and an agent or API token.
- The Compose tests check the network wall.

## Out of scope

- Using the person's own Chrome.
- Saved passwords and automatic sign-in. A later spec covers how logins are kept.
- Video sites that need DRM.
- Native installers.
