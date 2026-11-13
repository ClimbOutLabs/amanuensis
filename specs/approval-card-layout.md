# Spec: Approval card layout

**Status:** implemented

## Problem

The cards where Aman asks before it acts did not look or read alike. A browser card, a mail card, a calendar card, a command card and a held action each used their own layout. The headline often ran on for several sentences, because the reason Aman was asking was glued onto the question. The same fact could appear two or three times: in the headline, in a stub line, in a details row and again in the raw request. Buttons sat in different orders and sizes from card to card, and on a phone long labels could spill out of the card.

## Solution

One card layout, built from shared parts, for every approval card:

1. **Status line.** "Waiting for you" with a gold dot, or once answered, a short line such as "Allowed · 09:14".
2. **The question.** One short question, such as "Open a page on example.org?".
3. **The reason.** One quiet sentence on why Aman is checking first, such as "Searches are set to ask, so Aman is checking with you first." It comes from the card's own wording (`copy.reason`), separate from the question, and is always visible. It replaces the old "Why I'm asking" button.
4. **Facts, once.** Label and value rows in one box: Address or Where, To, Amount, Command. A fact the question already names is left out of the rows.
5. **Choices in one row.** The main choice is filled; every other choice is the same outlined button. The order follows the card wording's safe-first rule: on a card where saying yes is risky (for example sending mail, or cancelling a reminder), the safe choice comes first and the yes is not the filled button. Otherwise the order is: yes, Always allow this here, Approve all, Change it, no.
6. **Details, only when it adds something.** The raw request and the standing grant fold behind Details. Details is hidden when the raw request only repeats a fact already shown.

Mail keeps its own body block and sticky action bar, but uses the same status line, question, reason and fact rows.

## Design decisions

- **No string parsing.** The card wording (`copy`: headline, reason, consequence) already carries the question and the reason separately. The layout only places them; it never splits a sentence back out of the question.
- **The reason stays in audit text.** The audit log still records the question and the reason together, so nothing is lost from the record.
- **Text at body size.** Every line on the card uses the chat body size, so a card is never harder to read than the chat around it.
- **Phone first.** On a narrow screen the fact rows stack and the buttons share the row and wrap their labels instead of overflowing.
- **One tick.** The old tear-off animation is gone. A small gold tick plays once on approval, under the same rules that limited the old animation.

## Scope

- Core permissions: the browser question names the site ("Open a page on example.org?"); a link chosen by something Aman read says so once, on the reason line, naming where it came from; the audit text keeps the card's reason. No card schema change.
- UI: shared card parts, and the permission, mail and held action cards rebuilt on them.
- Docs: "Approval cards" in the chat UI guide.

## Privacy

No new data is collected, stored or sent. The reason sentence was already shown and recorded; it is now always visible. Cards still show exactly what will be sent before anything is sent. Tests use made-up names, addresses and hosts only.

## Testing

- Core tests check the browser question, the link-source sentence said once, and that the audit text keeps the reason.
- UI tests check the layout order, that each fact shows once, the button order including safe-first, when Details appears, and the answered line.
- Browser tests check the cards at phone width and that all card text is at body size.
- All test data is synthetic.

## Out of scope

- Cards saved before this change keep their long headline; the reason is not split back out of old saved text.
- New approval kinds or new choices.
