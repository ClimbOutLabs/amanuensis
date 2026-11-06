# Spec: Noticing

**Status:** implemented

**Scope note:** This spec covers what the assistant watches for (mail from people the person marked always important, calendar clashes and travel, bills and deadlines, approvals that wait), how it decides how loudly to say so, and the Reach me settings page. It builds on the delivery feed in [Reaching You](notifications-delivery.md). Text messages and phone calls are separate work: this spec only leaves the place for them.

## Problem

The assistant only spoke when the person opened a chat. A clash on the calendar, a bill due in two days or an approval left waiting went unnoticed, and a person had no say in what could interrupt them.

## Solution

Watchers look for a few kinds of event. Each new event is judged once by the model a new chat starts on, then the person's own rules decide what happens. Everything lands in the bell with the reason it was sent. The person chooses, in Settings, Reach me, what may reach them and how.

## Levels

- **Note**: a quiet item in the bell. No push. This is where most things end up.
- **Nudge**: a delivery with a push notice to the person's devices.
- **Call**: a phone call. Until phone calls are set up, a call that survives every rule is delivered as a nudge, and the reason says so. The level rules for calls stay in code and are tested, so a phone channel only has to report itself available.

## Watchers

- **Mail** every 10 minutes, only mail that arrived since the last check, with two minutes of overlap and never more than a day back. Mail is read oldest first in pages (Gmail: up to 500 thread ids, the oldest 50 threads read). When a page is full, the checkpoint moves only to the last mail read, so the rest is read on the next pass.
- Mail from an always-important sender counts only when the mail server confirms the sender. DKIM or SPF must pass and align with the From domain, read from the topmost Authentication-Results header (RFC 8601) of a server the source trusts. Comments and quoted strings are read as the RFC says, and a quoted property value never counts. Alignment compares registrable domains from the public suffix list. A header that cannot be read verifies nothing. A source with no trusted servers verifies nothing. Otherwise it is ordinary mail.
- **Bills and deadlines** in new mail: a due date within 3 days with nothing later in the thread saying it was paid. A bill due later is tracked and checked again as it comes near.
- **Calendar** every 30 minutes: two events overlapping in the next 24 hours, and an event with a place starting within the person's travel lead time (default 90 minutes). On Google, an event is the person's own when they organised it, accepted it, or no one else is on it. On CalDAV the stored invite says who organised and who accepted in words its sender wrote, so an event is own only when no one else is on it. A clash is own only when both events are. An invite the person never accepted can only become a note.
- **Approvals** for everyone on the instance that have waited longer than the person's chosen time (5 to 20 minutes, default 15), checked every 5 minutes. A request for the person's ok closes itself after 30 minutes when they open the chat, so an approval is only raised while it can still be answered, and the setting cannot go past 20 minutes. A waiting approval is delivered with kind `approval_waiting` and the approval's id, so the bell links to it. One that was answered before it went out is dropped.

Each finding has a stable id, so the same thing is never raised twice. When nothing new is found, no model is called.

## From finding to delivery

- A finding is recorded as pending (or, for a bill due later, tracking) before anything is decided, and the watcher's checkpoint moves only after that. A pass that stops halfway leaves pending events for the next pass, never lost ones.
- A pass claims a pending event with one atomic update that stores its claim id and time. Only the holder of the claim can record the decision. A claim older than 10 minutes counts as left behind, and another pass may take it.
- A failed delivery puts the event back as pending. After five failed attempts it is marked failed and not tried again. Waiting for another pass is not a failure.
- An event that is no longer worth saying when its turn comes (an event that has started, a bill past its due date, an approval past its 30 minutes) is dropped.
- How loudly to reach a person is decided under a short per-person lease (60 seconds, taken again on a later try when busy). So two passes never both read "no nudges yet" and both nudge, or both call inside the gap.
- How much has already reached the person is read from the delivery feed itself. Only what the assistant noticed counts toward the daily nudges. Reminders and Try it never do. Any delivery that went out as a call counts toward the time between calls.

## Deciding how loudly

One model call per new event asks only for a level, a reason and a one-sentence message. The model can ask, never decide. These rules run in code on its answer:

- Each kind has a highest level. Bills and waiting approvals can nudge but never call.
- A call needs the kind to be ticked for calls, calls to be switched on, no quiet hours, and at least 6 hours since the last call.
- Text that only claimed something (for example "urgent" in a bill) can raise a note and nothing more. A message or reason that carries a link, an address or a phone number only the read content named is replaced by a plain sentence the watcher wrote. When a kind can only be a note, no model is called.
- At most 5 nudges a day (the person can change this). Past it, events become notes.
- When the daily token cap is reached, or no model can answer, events become plain notes and no model is called.

Quiet hours (default 21:00 to 08:00 in the person's time zone) hold back calls only. A person who never saved Reach me uses the time zone of their schedules, or UTC when they have none.

The model call uses the model a new chat starts on, with no tools. It is metered under the `noticing` usage role and counts toward the daily Token Factory cap.

## Reminders

Reminders follow the same channels. A reminder is never quieter than a nudge. A person can mark a reminder urgent, and with "Call me for reminders I mark urgent" ticked it may call, under the same call rules. A reminder that goes out as a call counts toward the time between calls, read from the feed. Reminders never count toward the daily nudges. A reminder that could call waits for the person's lease, and if another pass holds it every time, it arrives as a nudge.

## Reach me settings

- Channels: in the app (always on), push for each device, texts and phone calls. Texts and calls show "not set up yet" and cannot be switched on until they exist.
- Always-important senders, with suggestions found in memories. Nothing is added until the person accepts it.
- Time zone, daily nudge limit, travel lead time and approval wait.
- Settings that only matter for calls (which kinds may call, quiet hours, hours between calls, call me for urgent reminders) are hidden until a phone channel is set up, with one line saying they appear then. Saved values are kept.
- A Try it button for each channel.

## Design Decisions

- Notes appear in the bell as quiet items. They never push.
- Every note and nudge is written to Activity with its reason.
- The assistant's name in any text comes from the person's own choice, never a fixed name.
- The channel list, levels and rules live in one place, so a phone channel plugs in by reporting itself available and acting on a `call` decision, with no change to the watchers.
- Settings, events, claims, leases and checkpoints are stored in SQLite and Postgres behind one store interface, and Reach me settings are in data export and import. An import brings texts and calls in switched off.
- The controller runs the passes by calling an internal route on the server with the service key, so the server alone holds mail, calendar and model access.

## Scope

- `reach_settings`, `noticing_event` (with claim id, claim time and attempts), `noticing_checkpoint` and `reach_lease` tables on SQLite and Postgres, with shared store contract tests
- Routes under `/api/v1/user/reach` (get, save, suggestions, test) and the internal `/api/internal/noticing/run`
- Mail and calendar sources: Google mail and Google Calendar for a person who connected them, and, for the instance owner only, the instance's own Email (IMAP) and Calendar (CalDAV) connectors, read with their read-only tools. Those connectors hold one mailbox and one calendar for the whole instance, so they belong to the owner. The owner is the default person when sign-in is off, and otherwise the single address the owner signs in with when people are told apart by email (the same rule the installer's name for the owner follows). With several addresses or another sign-in claim the instance names no owner and no one gets the shared connectors. Everyone else gets mail and calendar noticing only from their own Google connection.
- The Email (IMAP) connector does not pass on the receiving server's Authentication-Results, so no sender can be confirmed there. An always-important sender on IMAP mail is read as ordinary mail: it can still raise a bill note, never a nudge or call for the sender. The connector gives no thread, so "paid" is looked for in later mail with the same subject.
- Settings, Reach me page

## Privacy

- Events are read with read-only calls to the person's own mail, calendar and chats.
- When an event is judged, the model a new chat starts on sees a short, trimmed description of that one event (for example a sender, a subject and the start of the message). Nothing is sent when there is no event.
- Nothing is sent to anyone else. Push notices carry no event text, as before.
- Memory suggestions come from the person's own memories and are only questions.

## Testing

All tests use synthetic data, never a person's real data.

- Each watcher raises one event and no duplicates
- No event means no model call
- A model answer of call is lowered by each rule, including a kind not ticked for calls
- An email claiming urgency does not raise the level
- An always-important sender that fails the sender checks is treated as ordinary mail
- At the token cap, only notes are produced
- Reminders: urgent, tick and call gap
- Shared store contract tests, route tests, and an export and import round trip with an older-format file

## Known limits

- Event ids come from the mail or calendar source. Switching the same mailbox between Google and the Email (IMAP) connector changes the ids, so one mail can be raised a second time. This is rare and the second item is the same note or nudge, so it is not worth a cross-source match.
- Gmail mail that carries no Authentication-Results of Google's own lets a forged header claiming to be Google's sit on top. Gmail adds its own header to mail it receives, so this needs mail that skipped Gmail's checks.

## Out of Scope

- Text messages and phone calls
- A summary of notes in the morning brief. Notes stay in the bell.
