# Spec: Noticing

**Status:** implemented

**Scope note:** This spec covers what the assistant watches for (mail from people the person marked always important, calendar clashes and travel, bills and deadlines, approvals that wait), how it decides how loudly to say so, and the Reach me settings page. It builds on the delivery feed in [Reaching You](notifications-delivery.md). Text messages are covered in [Text Messages](text-messages.md). Phone calls are separate work: this spec leaves the place for them.

## Problem

The assistant only spoke when the person opened a chat. A clash on the calendar, a bill due in two days or an approval left waiting went unnoticed, and a person had no say in what could interrupt them.

## Solution

Watchers look for a few kinds of event. Each new event is judged once by the helper model, then the person's own rules decide what happens. Everything lands in the bell with the reason it was sent. The person chooses, in Settings, Reach me, what may reach them and how.

## Levels

- **Note**: a quiet item in the bell. No push. This is where most things end up.
- **Nudge**: a delivery with a push notice to the person's devices, and a text when the person has texts on and a confirmed number.
- **Call**: a phone call. Until phone calls are set up, a call that survives every rule is delivered as a nudge, and the reason says so.

## Watchers

- **Mail** every 10 minutes, only mail that arrived since the last check. Mail from an always-important sender counts only when the mail server confirms the sender (DKIM or SPF passes and matches the From domain, read from the topmost Authentication-Results header of the receiving server). Otherwise it is ordinary mail.
- **Bills and deadlines** in new mail: a due date within 3 days with nothing later in the thread saying it was paid. A bill due later is tracked and checked again as it comes near.
- **Calendar** every 30 minutes: two events overlapping in the next 24 hours, and an event with a place starting within the person's travel lead time (default 90 minutes).
- **Approvals** that have waited longer than the person's chosen time (5 to 20 minutes, default 15), checked every 5 minutes. A request for the person's ok closes itself after 30 minutes when they open the chat, so an approval is only raised while it can still be answered, and the setting cannot go past 20 minutes.

Each finding has a stable id, so the same thing is never raised twice. When nothing new is found, no model is called.

## Deciding how loudly

One helper-model call per new event asks only for a level, a reason and a one-sentence message. The model can ask, never decide. These rules run in code on its answer:

- Each kind has a highest level. Bills and waiting approvals can nudge but never call.
- A call needs the kind to be ticked for calls, calls to be switched on, no quiet hours, and at least 6 hours since the last call.
- Text that only claimed something (for example "urgent" in a bill) can raise a note and nothing more. A message wording that carries a link or address only the read content named is replaced by a plain sentence the watcher wrote.
- At most 5 nudges a day (the person can change this). Past it, events become notes.
- When the daily token cap is reached, or no model can answer, events become plain notes and no model is called.

Quiet hours (default 21:00 to 08:00 in the person's time zone) hold back calls only.

## Reminders

Reminders follow the same channels. A reminder is never quieter than a nudge. A person can mark a reminder urgent, and with "Call me for reminders I mark urgent" ticked it may call, under the same call rules. Reminder decisions are recorded so calls count toward the time between calls.

## Reach me settings

- Channels: in the app (always on), push for each device, texts and phone calls. Texts have their own number and code flow when the server has a text provider (see [Text Messages](text-messages.md)); until then, and for calls, they show "not set up" with the one thing to do, and cannot be switched on.
- Always-important senders, with suggestions found in memories. Nothing is added until the person accepts it.
- Which kinds may call. All off by default.
- Quiet hours, time zone, daily nudge limit, hours between calls, travel lead time and approval wait.
- A Try it button for each channel.

## Design Decisions

- Notes appear in the bell as quiet items. They never push.
- Every note and nudge is written to Activity with its reason.
- The assistant's name in any text comes from the person's own choice, never a fixed name.
- The channel list, levels and rules live in one place, so a phone channel plugs in by reporting itself available and acting on a `call` decision, with no change to the watchers. Texts did exactly that: `reachChannelsFor` reports them available when Twilio is set up, and a text sender joins the delivery layer.
- Settings, events and checkpoints are stored in SQLite and Postgres behind one store interface, and Reach me settings are in data export and import. An import brings texts and calls in switched off, and the number for texts in unconfirmed.
- The controller runs the passes by calling an internal route on the server with the service key, so the server alone holds mail, calendar and model access.

## Scope

- `reach_settings`, `noticing_event` and `noticing_checkpoint` tables on SQLite and Postgres, with shared store contract tests
- Routes under `/api/v1/user/reach` (get, save, suggestions, test) and the internal `/api/internal/noticing/run`
- Mail and calendar sources: Google mail and Google Calendar for a person who connected them, and, for the instance owner only, the instance's own Email (IMAP) and Calendar (CalDAV) connectors, read with their read-only tools. Those connectors hold one mailbox and one calendar for the whole instance, so they belong to the owner. The owner is the default person when sign-in is off, and otherwise the single address the owner signs in with when people are told apart by email (the same rule the installer's name for the owner follows). With several addresses or another sign-in claim the instance names no owner and no one gets the shared connectors. Everyone else gets mail and calendar noticing only from their own Google connection.
- The Email (IMAP) connector does not pass on the receiving server's Authentication-Results, so no sender can be confirmed there. An always-important sender on IMAP mail is read as ordinary mail: it can still raise a bill note, never a nudge or call for the sender. The connector gives no thread, so "paid" is looked for in later mail with the same subject.
- Settings, Reach me page

## Privacy

- Events are read with read-only calls to the person's own mail, calendar and chats.
- When an event is judged, the helper model sees a short, trimmed description of that one event (for example a sender, a subject and the start of the message). That is the model the person chose for helper jobs. Nothing is sent when there is no event.
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

## Out of Scope

- Phone calls
- A summary of notes in the morning brief. Notes stay in the bell.
