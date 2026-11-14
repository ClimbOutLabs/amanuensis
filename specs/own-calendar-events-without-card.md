# Spec: Own-calendar events without a card

**Status:** approved

## Problem

Every new or changed Google Calendar event shows an approval card, even an event only the owner is on. Adding "dentist at 10" to your own calendar reaches nobody else, yet it waits for a tap like an email does.

## Change

Adding an event to the owner's main Google Calendar, or changing an event the owner organizes there, runs without a card when nobody else is on the event. It is still written to the activity log, once Google confirms the save.

These keep asking, exactly as before:

- Any event with a guest, whether or not Google emails them. A change cannot add a guest (`update_event` takes no attendees).
- A second copy of an event this chat added in the last few minutes.
- Every calendar write in a scheduled run (held for the owner's OK).
- Every calendar change through the CalDAV connector or any other connector. CalDAV can write to any calendar the login reaches, including ones shared with other people, and Aman cannot tell which those are.
- Deleting. Google Calendar has no delete tool; CalDAV deletes always ask.

## Design

- One rule, `staysOnOwnCalendar` in `calendar/eventWrite.ts`, decides it from the request the host will send: no attendees, no guest email, nothing hidden from guests, and not a repeat create. The calendar is always `primary` by type, and `resolveUpdate` already refuses events someone else organizes or whose guest list Google cuts short.
- The classifier returns Tier 1 with reason `own_calendar_write` when the rule holds and the run is attended. Otherwise the existing card logic is unchanged.
- Tier 1 calls skip the dispatch re-check, so the calendar tool enforces the rule itself. A call that reaches it with no answer must match the arguments it was classified with, must still hash to the same request against the event as Google holds it now, and must still pass `staysOnOwnCalendar`. Otherwise nothing is saved. A "no" answer still saves nothing.
- The tool writes one activity log row (Tier 1, `ran`) after Google saves it, or a `denied` row when it was not saved.

## Privacy

No new data flows. The same request goes to Google as before; the activity log row holds the title, time and zone, as approved writes already do.

## Testing

Synthetic data only. Classifier tests cover create and change with and without guests, repeats, scheduled runs, and connectors with the same tool name. Tool tests cover the write, the log row, and refusals when the call or the event changed after the check. A server journey adds an event through a real turn and reads the activity log.

## Out of scope

- Skipping the card for CalDAV or other connectors.
- Any change to deletes or guest handling.
