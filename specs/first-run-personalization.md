# Spec: First Run and Personalization

**Status:** implemented

## Problem

A new owner signs in, lands in Settings under Models, and nothing points them at Personalization. That page is where they tell Aman their name, how to be addressed, and what to remember about them, and where the learned profile lives. Without it, Aman never greets them by name and every chat starts cold. The profile also had no field for the owner's name at all; the only place to put it was free text.

## Solution

Three small things, all driven by real state and none of them nagging.

1. **A first-run checklist.** One card, shown on the Models page (where a new owner lands) and on the empty new-chat screen (where they land once a model exists). It lists: add a model; tell Aman about you (name and form of address, linking to Personalization); try your first chat; and, as an optional line, connect a memory bank. Each line ticks itself off from what the server reports: a model is configured, the profile carries a name, at least one chat exists, the bank is connected. A Dismiss control puts the card away for good. The dismissal is stored on the server, so it follows the owner to every browser and survives a cleared cache.
2. **One quiet line in chat.** After the checklist is put away, an empty new chat whose owner has still not given a name shows a single line linking to Personalization. The model is never asked to ask; no prompt changes.
3. **Name first on the Personalization page.** Two new profile fields, `user_name` and `address_as`, sit at the top of the page with plain help text. They join the model-facing personalization context for the default assistant and for personas alike, since they describe the user, not the assistant.

## Design Decisions

**Dismissal is a global setting, not a profile field.** It goes in the existing global settings store under `first_run_guide_dismissed`, read and written through `GET` and `PUT /api/v1/settings/first-run-guide`. One account per instance makes the instance-wide row the owner's. Putting it on the personalization profile would tie a UI preference to the profile's revision and digest, and would need a profile to exist before the card could be dismissed.

**Existing digests stay valid.** The two new fields enter the content digest only when set, the same way the learned profile does, so a stored row that never set them keeps the digest it has and does not advance a revision on the next unrelated save. Clients that predate the fields still send a complete profile; an omitted key reads as null.

**The checklist reads state the host already has.** The model and memory bank come from the setup state the welcome screen already used. The chat count is one list call with a page size of one. The name comes from the personalization provider already mounted around the chat, so saving a name ticks the line without a reload or a poll.

**Links open sections in place.** Inside the shell the links switch the Settings section directly; outside it they fall back to the host's settings URL; with neither they are plain text that still says where to go.

## Scope

- Server: profile fields, migrations for SQLite and Postgres, the first-run-guide setting and routes, context rendering, demo seed, docs.
- UI: the checklist card, the welcome screen, the Settings landing, the Personalization page order and copy, the host wiring that reads and writes the dismissal and the chat count.

## Privacy

The name and form of address are user-authored profile text. They are stored in the local database beside the rest of the profile, rendered into the per-turn personalization context exactly as the existing profile fields are, and never leave the machine except inside a model request the owner already configured. The dismissal flag is one boolean in the local settings table. Nothing new is written to browser storage, and nothing is sent to any third party.

## Testing

Unit tests cover the checklist's state logic, the card, the welcome screen, the Personalization page order, the profile schema defaults, the context rendering and digest stability, both stores through the shared contract suite, the first-run-guide routes, and the host API clients. A Playwright test renders every screen from a fixture at desktop and phone width, in light and dark, and photographs it. All test data is synthetic; no real user data is used.

## Out of scope

- Asking the model to collect the name in conversation.
- A multi-step onboarding wizard or any blocking first-run flow.
- Changes to the learned profile or to profile learning.
