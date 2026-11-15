---
title: 'Browser setup'
description: "How Aman's own browser is set up, walled off and turned on, for the person who runs Aman."
---

This page is for the person who runs Aman. It explains how Aman's own browser is set up and walled off. To use the browser and the live browser, see [Aman's browser](../packages/trueforge/guide/topics/live-browser.md).

## What it is

Aman's browser is a real Chromium browser. It runs on a virtual screen in its own container, next to Aman on your computer. It is a separate browser with its own sign-ins, not your own Chrome.

- Each person gets one profile that persists, so sign-ins survive restarts.
- Each chat gets its own tab and only sees the page it opened. Only opening a page makes a tab.
- A person keeps at most eight tabs. Opening a ninth closes the one used longest ago. A chat whose tab was closed is told to open its page again.
- A page waits up to 30 seconds to finish opening before Aman gives up.

## Turning it on

=== "Installed Aman"

    The installer turns the browser on in every instance. Installing or upgrading sets it up, so there is nothing to do.

    The installer makes the shared secret `BROWSER_SECRET` once and keeps it in the instance's `.env` file. It sets `BROWSER_ENABLED` and `BROWSER_URL` for the app itself.

=== "From a checkout"

    The development stack runs the browser only with the `browser` Compose profile, so an ordinary start does not build Chromium. To turn it on:

    1. In `packages/trueforge/.env`, set `BROWSER_ENABLED=true`.
    2. Set `BROWSER_SECRET` to a random value of 32 or more characters, for example from `openssl rand -hex 32`.
    3. Start the stack with the `browser` profile.

    `BROWSER_URL` is set by the Compose file to `http://browser-relay:8792`.

### Settings

| Setting                  | What it does                                                                                   | Default                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------- |
| `BROWSER_ENABLED`        | Turns the browser on. While it is off, Aman has no browser at all, whatever the other two say. | `false` (the installer sets `true`)     |
| `BROWSER_URL`            | The browser's private address, reached only through its gateway. Must be `http` or `https`.    | Unset. Required when the browser is on. |
| `BROWSER_SECRET`         | The value every request to the browser must carry. At least 32 characters.                     | Unset. Required when the browser is on. |
| `BROWSER_NAV_TIMEOUT_MS` | How long a page may take to open, in milliseconds.                                             | `30000`                                 |

With `BROWSER_ENABLED=true` and either of the other two missing, the server doesn't start, and its message names what to set.

## How it is walled off

The browser reads pages from anywhere, and some of them are hostile. So it shares a network with nothing else of Aman's.

- The browser container's only network is internal, with no route out. The only other thing on it is the browser gateway.
- Every request Chromium makes goes through the gateway's proxy: the first page, redirects, the page's own requests, form posts and WebSocket connections.
- The proxy looks up each site once and refuses anything on this computer or a private network. That covers loopback, home and office networks, link-local and cloud metadata addresses, carrier networks, and private IPv6 ranges. It then connects to the exact address it checked, so a site name cannot change its answer in between.
- Aman's server reaches the browser only through the gateway's relay. The relay listens only on the server's network, and the proxy only on the browser's.
- The relay checks `BROWSER_SECRET` and does not pass it on, so the browser's container never holds it. The browser answers only calls that come from the gateway.
- Chromium runs with its own sandbox on, with a stripped environment. Its container has no extra privileges and a read-only root, with limits on memory and processes.
- A page cannot move its tab to another site, open new windows or run service workers. Each redirect is checked as it arrives, and one to another site is refused. A site's own `www.` name, and a move from `http` to `https`, count as the same site.
- When a tab ends up on another site, for example after going back, nothing of that page is returned. Aman is told the address and must open it again, which goes through the usual checks.

## What Aman checks before it acts

- Opening a page sends its address to a site, so it gets the same checks as a web search.
- Reading, scrolling, going back and a screenshot only work on the open page and send nothing.
- Only a plain link to another page runs without asking. Aman opens its address instead of pressing it, so the page's own scripts don't run.
- A button, tab or menu runs the page's own script, which can send anything whatever its label says, so a click on one always asks first. Typing and picking an option ask first too, with the exact text on the card, because a page can send what is typed the moment it changes.
- Typing never presses Enter or Tab. Input that would land anywhere but the checked element, including a frame inside the page, is stopped.
- Every action runs only on the element that was checked, read where the page's scripts can't change what Aman sees. If the page changed in between, the action is refused and Aman reads the page again.
- The page text Aman reads never shows the value of a password, payment or one-time-code field.
- A page Aman reads comes from your signed-in browser, so Aman treats its content like your email: as information, not instructions.

## Screenshots

A page's text can't show what a chart, drawing, photo or video holds. So each read counts the pictures in view that are bigger than an icon, and tells the model to take a screenshot to see them. A screenshot goes to the chat for you. With it, the browser makes a second copy for the model. In that copy, every password, card and one-time-code field is covered, and so is every frame a page embeds from elsewhere. Each control in view gets a red box and a short label. The copy is drawn outside the page, and is left out when it cannot be made safely.

## The live browser

The live browser is the `/browser-live` page of the app. It works only for a signed-in person, and shows only that person's own tabs.

- It lists the person's open tabs, most recent first. Listing them never starts a browser.
- It asks for new pictures of the page only while the person is looking at it.
- A click in the live browser uses a real mouse click, so the same rules keep the tab on its site. Actions on one tab run one at a time, in order.
- Takeover hands the tab to the person. The tab never leaves the browser; only whose hand drives it changes. While it is taken over, Aman's own steps on that tab are refused, and the pointer moves in steps from where it last was, so the page sees a hand moving.
- The live browser reports a human check when the check's own frame is on the page, or the whole page is the check.
- Pasting into the live browser puts the text into the page as one paste, so a line break in it never presses Enter. Copying reads only the text the person selected in the page, never a password field. Neither the pasted nor the copied text is logged, kept, or shown to the model. The name and password boxes for a password manager paste the same way and are emptied once used.
- A file uploaded from the live browser is at most 10 MB. It goes into the file picker the page opened, or else the page's first file field. The page itself sends it.

## Your data

Each instance keeps its browser profiles in a Docker volume named `aman_<instance>_browser_profiles`. That is where the sites Aman's browser is signed in to are stored.

Removing an instance keeps the volume, and the installer says so. To delete it too, run:

```bash
installer/install.sh instance remove <name> --purge-data
```

The browser is off in incognito chats, because its profile keeps history and sign-ins between chats.

## Related

- [Aman's browser](../packages/trueforge/guide/topics/live-browser.md)
- [Privacy](privacy.md)
- [Safety](safety.md)
