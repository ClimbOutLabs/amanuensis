# Spec: Approval card layout

**Status:** implemented

## Problem

The cards where Aman asks before it acts did not look or read alike. A browser card, a mail card, a calendar card, a command card and a held action each used their own layout. The headline often ran on for several sentences, because the reason Aman was asking was glued onto the question. The same fact could appear two or three times: in the headline, in a stub line, in a details row and again in the raw request. Buttons sat in different orders and sizes from card to card, and on a phone long labels could spill out of the card.

## Solution

One card layout, built from shared parts, for every approval card:

1. **Status line.** "Waiting for you" with a gold dot, or once answered, a short line such as "Allowed · 09:14".
2. **The question.** One short question, such as "Open a page on example.org?".
3. **The reason.** One quiet sentence on why Aman is checking first, such as "Searches are set to ask, so Aman is checking with you first." It is a separate field, `plain_reason`, so it is never glued onto the question.
4. **Facts, once.** Label and value rows in one box: Address or Where, To, Amount, Command. A fact the question already names is left out of the rows.
5. **Choices in one row.** The main yes is filled; every other choice is the same outlined button. The order is always: yes, Always allow this here, Approve all, Change it, no.
6. **Details, only when it adds something.** The raw request and the standing grant fold behind Details. Details is hidden when the raw request only repeats a fact already shown.

Mail keeps its own body block and sticky action bar, but uses the same status line, question, reason and fact rows.

## Design decisions

- **A new field, not string parsing.** The server now sends the reason in `plain_reason`. The UI never tries to split a sentence back out of the question.
- **The reason stays in audit text.** The audit log still records the question and the reason together, so nothing is lost from the record.
- **Text at body size.** Every line on the card uses the chat body size, so a card is never harder to read than the chat around it.
- **Phone first.** On a narrow screen the fact rows stack and the buttons share the row and wrap their labels instead of overflowing.
- **One tick.** The old tear-off animation is gone. A small gold tick plays once on approval, under the same rules that limited the old animation.

## Scope

- Core permissions: `plain_reason` on the card schema; the browser, search, calendar, CalDAV, command and steering checks fill it instead of appending to the question.
- UI: shared card parts, and the permission, mail and held action cards rebuilt on them.
- SDK and OpenAPI: the new optional field.
- Docs: "Approval cards" in the chat UI guide.

## Privacy

No new data is collected, stored or sent. The reason sentence was already shown and recorded; it now has its own field. Cards still show exactly what will be sent before anything is sent. Tests use made-up names, addresses and hosts only.

## Testing

- Core tests check that each check puts its reason in `plain_reason` and keeps the question short.
- UI tests check the layout order, that each fact shows once, the button order, when Details appears, and the answered line.
- Browser tests check the cards at phone width and that all card text is at body size.
- All test data is synthetic.

## Out of scope

- Cards saved before this change keep their long headline; the reason is not split back out of old saved text.
- New approval kinds or new choices.
