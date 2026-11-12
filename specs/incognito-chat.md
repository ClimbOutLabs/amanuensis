# Spec: Incognito chats

**Status:** approved

## Problem

Every chat teaches Aman something. Memory retain runs after each turn, profile learning updates the learned profile, the chat joins past-chat search and sits in history, and its files stay on disk. Sometimes you want to ask something once and leave no trace: a medical question, a gift, a draft you do not want remembered. Today the only way is to turn memory off in Settings and delete the chat by hand, and even then profile learning and leftover files remain.

## Solution

An incognito chat: a chat you start on purpose that Aman does not remember. When it closes it is gone. The server enforces every guarantee below from a flag on the session row; nothing depends on the model behaving.

Two rules do not bend:

1. **Read yes, write no.** An incognito chat may recall the vault but never writes to it, in any persona.
2. **Actions still leave a receipt.** Approval tiers, held actions, approval tokens and the action audit work exactly as in a normal chat, and the receipts outlive the chat.

## 1. Data model

- `session.is_incognito`: boolean, not null, default false. Set only when the chat is created. The update path refuses to change it with: "A chat is incognito from the start or not at all. Start a new incognito chat instead."
- `session.private_expires_at`: the last turn time plus 24 hours, renewed on every completed turn. The chat is deleted at close or at expiry, whichever comes first.
- Migrations for both backends. Both fields are carried on the create request and the session DTO.
- Export skips incognito chats. An older export without the fields imports unchanged, through an import upgrade step with an older-format fixture.

## 2. One gate

One function, `sessionKeepsNothing({ session })`, is called by every writer:

- memory retain (the turn drain hook and the reliability loop)
- daily notes and summaries
- profile learning
- past-chat search indexing
- brief items and the Home feed
- bug reports, which leave an incognito chat out

The same gate decides which tools the chat is offered. Aman's own lasting things are read-only there: spaces, schedules, reminders and the notes folder can be listed and read but not made or changed, and personas can be listed and switched to but not added. A tool set offers only its tools marked read-only, plus tools that change nothing beyond the chat, so a new writing tool is left out until it says otherwise. The permission check refuses the same calls on its own, from the tool the host named and never from what a tool says about itself, so a call that reaches it anyway does nothing. A connector the person added can only read: the check lets through a read it knows by its name and refuses every other call, without a card. The host's own mail and calendar keep their cards. The web browser is not mounted, because it keeps one lasting profile per person, with history and sign-ins. The model is told what it cannot do here and to point the person to a normal chat.

`GET /api/v1/sessions` leaves incognito chats out unless `include_private=true`, and only the person who started an incognito chat can see it. The client keeps the one open incognito chat's id in memory, never in browser storage, and asks for it by name. Spaces in this app are the pages Aman keeps, so the chat-side grouping is folders: moving an incognito chat into a folder is refused with "Incognito chats cannot be added to a folder. Start a normal chat to keep it in one." Session metrics keep per-model token counts.

## 3. Deletion

- **Close and delete** deletes the chat for real, not with a flag: the session, turns, thread context, session events, chat images, turn artifacts and any blob no other chat uses, in one transaction. Its sandbox files go with it.
- The per-model token counts of a deleted chat are kept, with no words and no chat id, so the usage summary stays right.
- An expiry sweep runs on the controller loop, the same shape as the schedule dispatch, and once at boot. It deletes only incognito chats past their expiry.
- On SQLite, deleted pages are overwritten and the write-ahead log is emptied after a delete, so the words cannot be read back from the file.
- The nightly backup removes incognito chats from its copy of the database, so a chat open at backup time is not kept.

## 4. Kept by design

- Approval tokens and held actions.
- The action audit, whose lines can repeat an action's words, such as an email's address.
- Anything a tool changed in the world, such as a sent email.

## 5. Honesty banner

A line above the composer says where the words go:

- Hosted model: "Nothing from this chat is kept here. It is answered by <provider name>, so the words do leave this machine."
- Local model: "Nothing from this chat is kept. It never leaves this machine."

The client reads the banner again when a turn starts or ends, when the persona pill is used, and when the window regains focus, so a switch to a persona on a hosted model shows.

A model counts as local only when its address is this machine (loopback, `localhost`, or `host.docker.internal`, or a name that resolves only to loopback). The check covers the chat's model, its helper models, and its persona's model.

## 6. UI

- **New chat:** a "Start incognito chat" choice on the new chat's composer, before the first message, with the line "Aman forgets this chat when it closes. It can still read what it already knows." Its hover text reads "Start a chat Aman forgets. Nothing from it is saved, and it is deleted when you close it."
- **Open incognito chat:** an ink frame instead of the accent frame, the banner above the composer, the Close and delete control (it asks once first: "Everything in this chat is deleted for good: every message, picture and file. It cannot be brought back."), and no status line for the assistant. Existing theme tokens and `rem` only.
- **Chat list:** a small "Incognito" label while the chat is open in that tab. It is never in search or recents.
- **Personas:** an incognito chat with a persona reads that persona's vault, writes nothing, and shows the same banner.

## Privacy

An incognito chat narrows what Aman keeps: no vault write, no learned-profile write, no past-chat search, no brief or Home item, no space, reminder, schedule, persona or note, no browser history, no history after it closes, no files, and no unsent text in browser storage. It does not narrow what leaves the machine: model, search and connector traffic is unchanged, and the banner says so. Only the receipts of actions and per-model token counts outlive the chat.

## Testing

All tests use synthetic data, never anyone's real memory or mail.

- Schema and migration tests on both backends.
- A pair test: an incognito turn produces no retain, daily note, embedding, brief item or Home item, and a normal turn produces all of them.
- The receipts of an incognito chat's actions (approval tokens and the action audit) survive its deletion. Held actions exist only in unattended runs, which an incognito chat never is.
- Delete removes every listed row and blob, on both backends.
- The sweep deletes only past-expiry incognito chats.
- Export omits incognito chats, and an older export imports with the default.
- Update refuses the flip with the exact message.
- An incognito chat is offered only the read tools for spaces, schedules, reminders and notes, cannot add a persona, has no browser, and is told so; a normal chat keeps them all.
- The permission check refuses each of those writes in an incognito chat, and any connector call it does not know as a read, even when the connector calls the tool read-only.
- The banner reads again after a persona switch and shows the hosted line.
- Unsent text in an incognito chat is never written to browser storage.
- An end-to-end run over the HTTP surface: an incognito chat is refused a change through a connector and saves an approved email draft, then Close and delete leaves only the receipts.

## Out of scope

- A per-chat local-model pin (Phase 2).
- "Forget this chat" for normal chats.
- Any change to approval tiers.
