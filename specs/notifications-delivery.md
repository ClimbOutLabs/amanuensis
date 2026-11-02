# Spec: Reaching You (Notifications Delivery)

**Status:** approved

**Scope note:** This spec covers the delivery feed, reminders moved onto it, the in-app bell, Web Push, Activity records and data import. Text messages and phone calls are later work and use the same feed.

## Problem

A reminder only reached a person while an Aman tab was open. A tab that did not set the reminder never found it, and "seen" was stored in each browser, so a reminder read on the phone still looked unread on the laptop. There was no single place that recorded what Aman tried to tell a person and whether it got through.

## Solution

One server-side feed of things Aman wants a person to see, called deliveries. Each delivery has a kind (reminder, note, nudge, approval waiting), a level, a reason, and a record of every channel it was sent on. Reminders write to this feed. The app shows the feed under a bell with an unread count, and devices that opted in get a Web Push notice.

## Design Decisions

**Server owns seen state.** Seen on one device is seen on every device. Every read and write is scoped to the tenant and the person who owns the delivery.

**Kinds and channels grow without migrations.** Kind, level and channel are plain text columns. The API validates kind with a discriminated union, so later parts add kinds and channels in code only.

**Push carries no content.** The push payload is the delivery id and a short title such as "Reminder". It never holds the reminder text, the reason or the assistant's name. The page fetches details after the person opens it.

**Push is opt-in per device.** A person turns notices on from a click in Settings. Push is off unless the server has a key pair. The installer creates the key pair at install, and on upgrade for instances that have none.

**The service worker stays inert.** It shows notices and opens items. It has no fetch handler and stores nothing, so it cannot touch API calls or streams.

**Outbound pushes use the public-address guard.** A registered push address cannot point the server at an internal host. A device the push service reports gone is removed.

**Permissive licenses only.** The push library is MIT. The common `web-push` package is MPL-2.0 and is not used.

## Scope

- `delivery` and `delivery_attempt` tables on SQLite and Postgres, bound by shared store contract tests
- Routes under `/api/v1/user/deliveries`: list (newest first, paged), unread count, mark seen, get one
- Reminders create a delivery after writing their line into the Reminders chat; the old browser polling and per-browser storage are removed
- A bell with the unread count in the main headers and a panel that lists deliveries; opening an item marks it seen
- Web Push with a service worker, per-device opt-in in Settings, and plain words for iPhone (Home Screen needed), unsupported and blocked browsers
- Every delivery and every channel attempt is written to the Activity log in plain words
- Deliveries are included in data export and import, with an upgrade step and an older-shape fixture; push subscriptions are not exported

## Privacy

- Delivery text stays in the person's own database
- Push payloads hold only an id and a generic title, so the push service never sees reminder text
- Push subscriptions are not exported, since they are tied to one browser
- Nothing in this spec texts or calls anyone

## Testing

All tests use synthetic data, never a person's real data.

- A due reminder with no open tab creates a delivery and a push
- A tab that set nothing shows the unread count
- Seen on one device is seen on another
- One person never sees or marks another person's deliveries
- The push payload holds no reminder text
- A dead push subscription is removed
- An upgraded install gets push keys
- The service worker takes no fetch events
- Older export files import through the upgrade step

## Out of Scope

- Text messages and phone calls
- Pruning old deliveries
- Quiet hours and per-kind notice settings
