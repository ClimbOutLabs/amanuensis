# Spec: Reach Me (Notifications Delivery)

**Status:** approved

**Scope note:** This spec covers the delivery feed, reminders moved onto it, the in-app bell, Web Push, Activity records and data import. Text messages and phone calls are later work and use the same feed. Quiet hours, the call rules and per-kind notice settings are covered by [Noticing](noticing.md).

## Problem

A reminder only reached a person while an Aman tab was open. A tab that did not set the reminder never found it, and "seen" was stored in each browser, so a reminder read on the phone still looked unread on the laptop. There was no single place that recorded what Aman tried to tell a person and whether it got through.

## Solution

One server-side feed of things Aman wants a person to see, called deliveries. Each delivery has a kind (reminder, note, nudge, approval waiting), a level, a reason, and a record of every channel it was sent on. Reminders write to this feed. The app shows the feed under a bell with an unread count, and devices that opted in get a Web Push notice.

## Design Decisions

**Server owns seen state.** Seen on one device is seen on every device. Every read and write is scoped to the tenant and the person who owns the delivery.

**A deleted chat takes its Open away, not the words.** When the feed is read, the chats a page of items links to are checked in one ownership lookup. An item whose chat no longer exists, or belongs to someone else, is served without the link; its text and reason stay in the feed, and there is no Open to fail. An item waiting on an approval in such a chat can never be answered, so it is resolved and leaves the feed. Opening an item looks its chat up first, and the panel stays open until the chat opens; when it cannot open, the panel says so in plain words instead of showing a raw error. Items already in the feed heal on their own, because the check happens when the feed is read, not when the item is written.

**Kinds and channels grow without migrations.** Kind, level and channel are plain text columns. The API validates kind with a discriminated union, so later parts add kinds and channels in code only.

**Push carries no content.** The push payload is the delivery id and a short title such as "Reminder". It never holds the reminder text, the reason or the assistant's name. The page fetches details after the person opens it.

**Push names no one.** The contact every push carries defaults to the project's public page, not the owner's email. The owner can set their own with `WEB_PUSH_SUBJECT`.

**A bounded number of devices.** A person keeps notices on for at most 10 devices. Turning on another drops the one turned on longest ago. A notice goes to at most 4 devices at a time. Settings asks the server whether this device is still saved, so a device that was dropped, or that its push service reported gone, reads as off and can be turned on again.

**New keys mean new subscriptions.** Each device records the key it was turned on with. After the keys change, a device on the old key is removed instead of sent to, and turning notices on again makes a fresh subscription with the new key.

**Push is opt-in per device.** A person turns notices on from a click in Settings. Push is off unless the server has a key pair. The installer creates the key pair at install, and on upgrade for instances that have none.

**The Reach me words name the assistant, and a failure says its kind.** The settings page speaks of the assistant by the name the person chose, not the product name. When turning notices on or off fails, the page says what kind of failure it was in plain words, with the one next step; the raw browser error stays in the console and on the error's cause. A certificate failure, and a SecurityError raised while subscribing, both mean this device does not trust the computer's own certificate yet, which a page can be opened past but the notice program cannot. The one next step the words name is the "Trust this computer" link the installer printed, opened on the device, the same step the phone help describes.

**The service worker stays inert.** It shows notices and opens items. It has no fetch handler and stores nothing, so it cannot touch API calls or streams.

**Outbound pushes use the public-address guard.** A registered push address cannot point the server at an internal host. A device the push service reports gone is removed.

**Permissive licenses only.** The push library is MIT. The common `web-push` package is MPL-2.0 and is not used.

## Scope

- `delivery` and `delivery_attempt` tables on SQLite and Postgres, bound by shared store contract tests
- Routes under `/api/v1/user/deliveries`: list (newest first, paged), unread count, mark seen, get one
- Reminders create a delivery, then write their line into the chat the reminder was set in, and the delivery links to that chat; a reply running in that chat holds the line, never the delivery; the old browser polling and per-browser storage are removed
- A reminder set outside a chat, one saved before the origin chat was recorded, and one whose origin chat has been deleted create a delivery with no link and no chat line; no chat is made for them, and there is no shared Reminders chat anymore
- A bell with the unread count in the left panel and a panel that lists deliveries; opening an item marks it seen
- Web Push with a service worker, per-device opt-in in Settings, and plain words for iPhone (Home Screen needed), unsupported and blocked browsers, and for each kind of failure while turning notices on or off
- Every delivery and every channel attempt is written to the Activity log in plain words
- Deliveries are included in data export and import, with an upgrade step and an older-shape fixture; push subscriptions are not exported

## Privacy

- Delivery text stays in the person's own database
- Push payloads hold only an id and a generic title, so the push service never sees reminder text
- The push service (Google, Apple or Mozilla, by browser) sees this computer's address and the project page as contact, and nothing about the person
- Push subscriptions are not exported, since they are tied to one browser
- Nothing in this spec texts or calls anyone

## Testing

All tests use synthetic data, never a person's real data.

- A due reminder with no open tab creates a delivery and a push
- A due reminder lands in the chat it was set in, and its delivery links there
- A due reminder with no origin chat, or whose origin chat was deleted, creates a delivery with no link and makes no chat
- A due reminder that names a chat someone else started creates a delivery with no link and writes nothing in that chat
- A due reminder whose chat has a reply running creates its delivery at once and writes its line when the reply ends
- A tab that set nothing shows the unread count
- Seen on one device is seen on another
- One person never sees or marks another person's deliveries
- The push payload holds no reminder text
- A dead push subscription is removed
- A device on an old key is removed, and turning notices on again re-subscribes
- An 11th device drops the oldest, and the dropped device reads as off in Settings
- A full export with many devices per item imports
- An upgraded install gets push keys
- The service worker takes no fetch events
- Older export files import through the upgrade step

## Out of Scope

- Text messages and phone calls
- Pruning old deliveries
- Quiet hours and per-kind notice settings (see [Noticing](noticing.md))
