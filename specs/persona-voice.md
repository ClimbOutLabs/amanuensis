# Spec: A Voice for Each Persona

**Status:** draft

## Problem

Replies can be read aloud in one of six voices on the person's own computer, picked once under Settings, Themes, Voice replies. Every persona then sounds the same. When a chat moves between personas, by voice or hands-free, the person cannot tell by ear who is answering.

## Solution

Each persona gets an optional reading voice, picked under **Voice** when adding or editing the persona in Roles and Personas. Picking one plays a short sample. Replies that persona wrote are read in its voice: when read aloud on their own after a spoken message (including hands-free), and from the speaker button under a reply. A persona left on "Same as my voice setting", and the main assistant, keep the person's own voice choice.

## Key decisions

- **Stored on the persona, on the server.** The voice is a new nullable `voice` field on the persona record (SQLite and Postgres migrations add the column; existing personas get null). The persona travels across browsers and in exports, so its voice does too. The person's own voice choice and the browser backup voice stay in the browser, as today.
- **The persona that wrote the reply, not the one active now.** A new `GET /api/v1/sessions/{session_id}/turns/{turn_id}/persona` returns which persona answered a turn, from the persona snapshot taken when the turn started (older turns fall back to the decision recorded for that turn). The app asks once per turn and reads the voice from the current persona list, so a voice changed in Settings applies to the next reading.
- **Full replace.** Persona create and update requests must send `voice` (a voice id or null), like every other persona field, so an update never clears it by leaving it out.
- **Fallbacks.** If the lookup fails, the persona was deleted, or its voice is not one of the six, the reply is read in the person's own voice. When the computer's voice is not set up, the picker is hidden and nothing is looked up, so reading starts at once with the browser voice.
- **Picker lives in the persona editor**, next to the persona's model, because it is a property of the persona. The Voice replies setting says a persona can have its own voice.

## Privacy

No new data leaves the computer. The voice id is a short label stored with the persona in the local database. The turn lookup returns only a persona id, and only to the chat's owner.

## Testing

Synthetic data only: store contract tests for the new column on both databases, API tests for the voice field and the turn lookup (owner checks included), an import test for an older export without the field, and UI tests for the picker, the auto-read and hands-free path, and the speaker button.

## Out of scope

- A per-persona browser backup voice (browser voices differ per device).
- Voices beyond the six built into the voice container.
- The assistant choosing a persona's voice through chat.
