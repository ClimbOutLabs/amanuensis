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
5. **Choices in one row.** Every choice is the same outlined button; none is filled, and the yes has no red ink. Each choice has one fixed place, the same on every card: yes (Allow, or Approve on a held action), Always allow in this chat, Always allow everywhere (held actions only; chat cards keep it in Details), Approve all, Change it (Edit on a mail card), Save as draft (mail only), then the no. A card leaves out the choices it does not offer, but never reorders the rest. On a card the server marks safe-first (`safe_choice`, for example sending mail, an event with guests, or a delete), the no stays last but uses safe words such as "Keep it" or "Don't send", and it is where keyboard focus lands when the person jumps to the card, so Enter does not send.
6. **Details, only when it adds something.** The raw request and the standing grant fold behind Details. Details is hidden when the raw request only repeats a fact already shown.

Mail keeps its own body block and sticky action bar, but uses the same status line, question, reason and fact rows.

## Design decisions

- **No string parsing.** The card wording (`copy`: headline, reason, consequence) already carries the question and the reason separately. The layout only places them; it never splits a sentence back out of the question.
- **The reason stays in audit text.** The audit log still records the question and the reason together, so nothing is lost from the record.
- **Quieter than the chat.** Only the question uses the chat body size, in semibold. The reason, the consequence, the facts and the buttons are one step smaller, and the status line is the smallest step. Order comes from weight and colour, not big size jumps, so a card never looks louder than the chat around it. A mail body stays at body size because it is what is being approved. Phone buttons stay at least 2.75rem tall.
- **No pressed button.** One fixed order with Allow first is easier to learn than an order that flips on risky cards, and with no filled or red button the card does not steer the answer. The risk shows in the question, the consequence line and the safe words on the no.
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
- UI tests check the layout order, that each fact shows once, that Allow comes first on every card including safe-first ones, that no choice is filled, that every card kind keeps each choice in its fixed place, when Details appears, and the answered line.
- Browser tests check the cards at phone width with tall enough buttons, that only the question and a mail body are at body size, and that no line is below the smallest type step.
- All test data is synthetic.

## Out of scope

- Cards saved before this change keep their long headline; the reason is not split back out of old saved text.
- New approval kinds or new choices.
