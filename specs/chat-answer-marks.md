# Spec: Chat Answer Marks (Unseen-Answer Dots)

**Status:** built, awaiting review

**Scope note:** This spec covers the dot and bold title a chat carries in the chat list when its latest answer has not been opened yet. The delivery feed and its own unseen marks are covered by the Reaching You spec and are not changed by this one.

## Problem

A scheduled run or a long answer could land in a chat while the person was looking elsewhere, and nothing in the chat list said so. The Reminders chat already showed a dot for an unseen reminder, through the delivery feed; ordinary chats had no equivalent, because nothing recorded when a chat's latest answer landed or how far the person had read it.

## Solution

When a turn finishes with a final message, the server stamps the chat's session metadata with the time the answer landed (`latest_answer_at`). The app reads those stamps from the session list it already knows how to fetch, and each browser remembers how far the person has read each chat. A chat whose stamp is newer than the browser's memory shows the same dot and bold title the Reminders chat gets, and opening the chat clears it.

## Design Decisions

**An answer is a finished turn's final message.** Interactive replies and scheduled runs both end through the same turn drain, so both stamp. A turn that ends paused with no final message added no answer and earns no stamp. Reminder lines keep their existing feed mark; they do not use this stamp.

**The stamp rides session metadata.** Session metadata is already on the wire and in the session list response, so no API shape changes and no schema migration is needed. The stamp is written by the turn follow-up, after the answer itself is saved, and a failed stamp is logged and swallowed: it can never fail a turn.

**Seen is kept per browser, on purpose.** The delivery feed owns server-side seen for its own items, where the same item must clear everywhere at once. A chat answer mark is a reading position in one browser's chat list, so it lives in that browser's local storage, like a scroll position. The cost is plain: reading a chat on the phone does not clear its dot on the laptop. If that ever needs to match across devices, the follow-up is a small server store for reading positions; this spec does not build it.

**First run starts clean.** The first time a browser checks, every answer that already exists counts as seen, so nobody opens the app to a wall of dots for old chats.

## Scope

- `latest_answer_at` session metadata key, stamped by the turn follow-up for every turn that finishes with a final message
- A chat-answer marks provider in the UI package: polls the stamps every 30 seconds while the page is visible, keeps the per-browser seen record, and exposes the unseen chat ids and a mark-seen call
- The chat list row shows the dot and bold title for an unseen answer, next to and independent of the feed mark, and clears it when the chat opens
- The frontend reads the stamps from the session list endpoint, newest chats first, up to the 100 most recently updated chats per check

## Privacy

- The stamp is a time and nothing else: no answer text, no counts
- The seen record never leaves the browser it was kept in

## Testing

All tests use synthetic data, never a person's real data.

- A turn that finishes with a final message stamps its chat; a turn that ends paused stamps nothing
- The stamp keeps the chat's other metadata and swallows store failures
- A first-run browser dots nothing; a later answer dots its chat; opening the chat clears the dot
- A browser with an older record dots only the chats answered since

## Out of Scope

- Server-side, cross-device seen for chat answers
- Folder rows in the chat list (they carry no dot today, not even for reminders)
- Any change to the delivery feed, the bell, or the Reminders chat mark
