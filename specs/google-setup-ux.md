# Spec: Painless Google Setup

**Status:** draft. Design only. Builds on `email-integration.md` (implemented) and the Google panel in Settings, Connectors.

## Problem

Connecting Gmail works, but the first run is a chore. The user must make a Google Cloud project, turn on the Gmail API, fill in a consent screen, add themselves as a test user, create a Desktop client and download its file. The panel lists these steps but cannot tell which are done, its links open the console with no project chosen, and the one error people actually hit, "Error 403: access_denied, has not completed the Google verification process", is not explained anywhere: it means "add yourself as a test user". After consent, a browser that is not on the Aman machine lands on "This site can't be reached" and the address has to be copied back by hand. A project left in Testing signs the user out every 7 days with no warning.

## Solution

Keep the user-owned client (no shared Aman project, no Google review) and make the setup a guided checklist that ticks itself off, translates every Google error into one sentence and a fix, removes the copy-paste step wherever the browser can reach Aman, and tells the user about the 7-day expiry before it bites. Nothing new leaves the machine: the only new data is the Google project id, which the user already has.

## 1. Guided setup

The panel becomes a numbered checklist. Each step has a short title, one line of plain words, a button that opens the right console page, and values to copy. Steps start grey, turn green when Aman can prove them done, and stay as "Done by you" ticks the user can set when Aman cannot see them.

Deep links use the Google Auth Platform pages. Once Aman knows the project id (step 1, or read from the client file, which carries `project_id`), every link gets `?project=<id>` so the console opens on the right project. The links, in order: create project `console.cloud.google.com/projectcreate`; Gmail API `apis/library/gmail.googleapis.com`; branding `auth/branding`; audience `auth/audience`; clients `auth/clients/create`; data access `auth/scopes`.

| Step | What the Google page looks like and what to choose | Pre-filled values | Aman can detect |
| --- | --- | --- | --- |
| 1. Project | A form with Project name and a Location. Type a name, select Create, wait for the notification, then copy the project id shown under the name (it ends in digits). | Name: `Aman` | Project id typed or read from the client file later |
| 2. Gmail API | A page with a blue Enable button. Select it. "Manage" means it is already on. | none | Yes, after the first sign-in: a profile call that fails with "access not configured" marks this step red |
| 3. Consent screen | "Google Auth Platform" wizard: App information (name, support email), Audience (choose External), Contact information (your email), then agree and Create. | App name: `Aman on my computer`. Support and contact email: the address you will sign in with | No. Ticked by the user |
| 4. Test user | Audience page. Under Test users select Add users, type the Gmail address you will sign in with, Save. | Hint: "the same address you will sign in with" | No, until sign-in fails with access_denied, which marks this step red with the fix |
| 5. Client | Clients page, Create client. Application type: the type Aman names (Desktop app, or Web application with the exact redirect URI shown). Name anything. Create, then Download JSON in the dialog. | Client name: `Aman`. Redirect URI (web mode only) | Yes: the file is parsed, its type is checked, and Check my client asks Google whether the client and callback are accepted |
| 6. Testing or Published | Audience page, Publishing status. Leave Testing, or select Publish app and Confirm. See section 4. | none | Partly: see expiry below |
| 7. Sign in | Google account picker, then "Google hasn't verified this app": select Advanced, then "Go to Aman on my computer (unsafe)", then Continue, then Allow. | Scopes are requested by Aman; nothing to type. Data access page is optional for your own use | Yes: the token response lists the granted scopes |

A "Check my setup" button runs what can be checked without consent: client file shape, type, and the dry Google request. After consent, the test call fills in steps 2, 4 and 7. Detected failures re-open the matching step with the fix from section 2, so the user never reads a raw Google code.

## 2. Error translation

One canonical table in core (`google/errorText.ts`) maps a Google code or reason to a sentence, a fix, and the checklist step to re-open. Every surface (panel, callback page, pasted address, tool failure, reconnect banner) reads from it. Messages name no internals.

| Google says | Aman says | Fix |
| --- | --- | --- |
| Access blocked, Error 403: access_denied, "has not completed the Google verification process" (shown by Google, never sent back to Aman) | You are not on the test user list yet. | Open Audience, add the address you sign in with under Test users, then Connect again. Or publish the app (section 4). The waiting state shows this before the user sees it. |
| error=access_denied sent back after the user chose Cancel | You did not allow access. | Connect again and select Allow. |
| redirect_uri_mismatch | Google does not accept the address Aman sends you back to. | Web mode: add the exact redirect URI from step 5 to the client. Desktop mode: create a Desktop app client, not a Web application. |
| invalid_client, deleted_client, unauthorized_client | Google does not recognise this client. | It was deleted, is from another project, or the id was mistyped. Download the client file again from step 5, or create a new client. |
| 403 accessNotConfigured, SERVICE_DISABLED | The Gmail API is turned off in your project. | Open step 2, select Enable, then Test connection. No new sign-in needed. |
| 403 insufficientPermissions, ACCESS_TOKEN_SCOPE_INSUFFICIENT, or a missing scope in the token | Google granted less than Aman asked for. | Connect again and leave every box ticked on the Google page. Tools for what was not granted are not offered. |
| invalid_grant on refresh, about 7 days after connecting | Your Google project is in Testing, so Google ends the sign-in every 7 days. | Reconnect now, or publish the app once so this stops (section 4). |
| invalid_grant at another time | Google ended the sign-in. | It was revoked in your Google account, or your password changed (Google ends Gmail sign-ins when it does). Reconnect. |
| "Google hasn't verified this app" screen | This is your own app, so Google has not reviewed it. That is expected. | Select Advanced, then "Go to ... (unsafe)". Nobody else can use your app. |
| "This app is blocked" | Google has blocked sign-in to your app. | Rare. Publish the app, or create a new project. |
| Timeout, no answer | Aman could not reach Google. | Check the connection and try again in a minute. |

The callback result page and the pasted-address errors use the same table, so "Google did not accept the code" becomes the matching row (mostly redirect_uri_mismatch, or an address used twice: "That address was already used. Connect again.").

## 3. Removing the copy-paste step

Google accepts two return addresses: a public https address (Web client) or the computer's own loopback address on any port (Desktop client). The consent ends in the user's browser, so the question is only whether that browser can load the return address.

| Where the browser is | Today | Recommendation |
| --- | --- | --- |
| Same computer as Aman, opened as localhost | Loopback: automatic | Keep. |
| Same computer, but opened by a LAN or tailnet name | Paste | Detect it: when the request host is not loopback but the install also listens locally, show "Finish on this computer" with a localhost link to the same panel. The consent then returns straight to Aman. |
| Phone or another device, Aman on a public https address | Web: automatic | Keep. |
| Phone or another device, Aman on a tailnet https name (ts.net) | Paste, because ts.net is treated as private | Allow it. Google checks only the form of a redirect URI (https, a public top-level domain), not whether it resolves publicly, and the redirect runs in the user's own browser, which is on the tailnet. One manual try confirms it. This removes paste for most phone users. |
| Phone or another device, plain http on a LAN name | Paste | Keep paste, but make it one tap: a Paste button that reads the clipboard, auto-finish when a valid address lands in the box, a shorter return path, and per-browser hints (Safari hides the scheme). Say up front which page will fail to load, so it is not a surprise. |
| Any device, the Google device flow | not used | Not possible: Google's device flow does not allow Gmail scopes. |

Paste stays as the floor. Nothing in it is removed.

## 4. The 7-day expiry

Google ends every refresh token issued by a project in Testing after 7 days. Publishing ("In production") stops that. For the scopes Aman uses, which Google calls restricted, publishing without verification is allowed: the consent screen keeps the unverified warning, the app is capped at 100 users, and Google may email the owner about verification. For one person using their own project, that is harmless.

Recommendation: the guide steers users to publish, in step 6, with the honest trade-off on the page: "Testing: nothing more to do, reconnect every 7 days. Published: no weekly reconnect, Google shows the unverified screen once, and you must confirm a dialog that says verification is needed. Either is safe for your own account." After publishing, reconnect once so the new sign-in is issued in production.

Aman cannot read the publishing status. It records `connected_at` and the user's choice in step 6 (`testing`, `published`, `unknown`). With `testing` or `unknown`, the panel and the connector row show "Expiring soon" from day 5 and a reconnect button. When a refresh fails with invalid_grant between day 6 and day 8, the error uses the Testing row from section 2 and the choice is set to `testing`.

## 5. Long term: one verified Aman app

A shared Aman client would make setup one tap: sign in, allow, done, with no console, no test users, no 7-day limit and no unverified screen. It needs Google's restricted-scope verification for Gmail: a public homepage and privacy policy on a domain the maintainers own, a demo video, written justification for each scope, and a yearly CASA Tier 2 security assessment by a Google-approved assessor (a self-scan lab is cheap, a full assessment is not). It also needs an Aman-owned client. A Desktop client's secret would ship in the open source code, which Google permits but any fork could reuse and abuse, with the ban landing on the shared client; a Web client needs a hosted redirect that hands the code to the local install, a new piece of infrastructure that briefly sees auth codes. Users would gain a one-tap setup and lose the "my project, my data" story. No action now; revisit if the guided flow still loses people.

## 6. UI sketch

Settings, Connectors, Google row and panel. All lengths in rem (1rem = 16px). Colours are theme tokens only: `--card-bg`, `--secondary-bg`, `--border`, `--text-primary`, `--text-secondary`, and `--success-bg`, `--warning-bg`, `--failure-bg`, `--info-bg` for status.

| State | Row chip (0.75rem text, 9999px radius, 0.125rem 0.5rem padding) | Panel top | Primary action |
| --- | --- | --- | --- |
| Not set up | "Not connected", `--text-secondary` | Checklist, step 1 open | Open Google Cloud |
| Half set up | "3 of 7 steps", `--info-bg` | Checklist, first undone step open; detected failures red with their fix | Continue |
| Connected | "Connected", `--success-bg` | Account, what is allowed, "Test connection" | Allow drafts and sending, if not yet |
| Expiring soon | "Expires in 2 days", `--warning-bg` | Banner: the Testing sentence from section 4, with Publish link | Reconnect |
| Broken | "Reconnect needed" or "Gmail API off", `--failure-bg` | Banner with the section 2 sentence and fix | Reconnect, or Open step 2 |

Panel layout: a 2xl modal on desktop with the checklist as a single column, 1.25rem padding, 1rem between steps, step numbers in a 1.75rem circle. Each step: title 0.875rem semibold, body 0.875rem `--text-secondary`, copy fields as today, one button row. The waiting state ("Finish in the Google window") shows what the next Google screen looks like and the access_denied fix inline.

Phone (under 40rem): the modal becomes a full-height sheet, 1rem side gutter, no horizontal scroll. The row chip wraps under the title. Buttons stretch full width, 2.75rem tall. The pasted-address box gets a Paste button beside it and the Finish button under it. Console links open in a new tab; the panel keeps its state when the user comes back.

## 7. Tests and build plan

Tests use synthetic data only: made-up client ids, secrets, project ids and a fake Google served by the existing test harness. No real account is ever used.

- Core: table test over every row of section 2, from Google code or reason to sentence, fix and step. Client file parsing reads `project_id`. Setup mode treats a ts.net https name as web. Expiry window: invalid_grant at day 7 reads as Testing, at day 30 as revoked.
- Server: status carries project id, `connected_at` and the publishing choice; the choice is stored and read back on both SQLite and Postgres through the store contract suite; deep links never appear in server responses, only the id.
- UI (jsdom): the checklist ticks step 5 on a valid file and shows the wrong-type fix on a bad one; the "Expiring soon" chip appears at day 5 for `testing` and never for `published`; the waiting state shows the access_denied fix; the Paste button fills and auto-finishes; the localhost hint shows only when the request host is not loopback.
- Docs: `docs/google.mdx` is rewritten against the checklist.

Small PRs, each shippable alone:

1. Error table in core and wire it into the panel, callback page, pasted address and tool failures.
2. Project id from the client file and the typed field; deep links with `?project=`.
3. Checklist with detection: client checked, scopes granted, API off and access_denied re-open their step.
4. Waiting state copy: what the next Google screens look like, with the access_denied fix.
5. Paste made easy: Paste button, auto-finish, per-browser hints.
6. Loopback hints: the "Finish on this computer" link, and ts.net https as web mode (owner decision).
7. Expiry: `connected_at`, the publishing choice, "Expiring soon" chip, and the Testing sentence on invalid_grant.
8. Row states and phone layout; then the docs rewrite.

## Privacy

New data: the Google project id, `connected_at`, and the publishing choice, stored next to the existing client and sign-in on the Aman server. The project id reaches Google only inside a console link the user clicks. Nothing is sent to anyone else. Error text never includes tokens, codes or secrets. Clipboard reads happen only on the user's tap.

## Out of scope

A shared Aman client (section 5). Calendar. More than one Google account. Encrypting secrets at rest, which is its own spec.
