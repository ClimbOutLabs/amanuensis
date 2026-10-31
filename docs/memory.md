# Memory

## How memory works, in plain words

Aman remembers things between conversations so you don't have to repeat yourself. Here is the plain-English version of how that works — the technical details live in [How it is stored and recalled](#how-it-is-stored-and-recalled) below.

**Memories are ordinary files.** Aman saves what matters from your conversations as plain text files (Markdown) on the server, in its memory folder (by default, `./data/memory` next to the server). There is no database to manage and nothing locked away: the files are human-readable, and they're yours.

**After each chat, only the lasting facts are saved.** Instead of keeping every turn word for word, the assistant picks out facts about you, plans, preferences, decisions, and anything you asked it to remember, and saves those. A turn with nothing lasting saves nothing. If a summary can't be made for a turn, nothing is saved for that turn, and the Memories page tells you. If you'd rather keep every turn word for word, turn the **Turn summaries** switch off in **Settings → Memory**; new turns are then saved word for word.

**Aman finds memories by meaning, not just words.** When you ask something, Aman searches your memories for meaning — so "where did we stay in Paris" finds the hotel note even though it says "Hotel Lumiere" and never mentions Paris. To do that, the first time Aman runs it downloads a small helper model once (about 120 MB), automatically in the background: the download starts when the server starts, so it's usually finished before you need it. There is nothing to install and nothing to click. After that one download, memory search works fully offline, and everything stays on this server. If the download can't finish, Aman just keeps finding memories with keywords, and keeps retrying in the background.

**Keep the memory folder safe.** The downloaded helper model lives inside the memory folder too, so they travel together. If you run Aman with Docker, make sure the memory folder is stored on a persistent volume: without one, your memories — and the downloaded model — disappear whenever the container is recreated.

## How it is stored and recalled

Memory is on by default. Amanuensis recalls from local Markdown files before every reply and retains what matters from each completed turn, so the model never has to remember to use it. Memories live as plain files under `MEMORY_MARKDOWN_DIR` (default `./data/memory`, relative to the server's working directory) — human-readable, portable, and yours. In Docker, mount a volume at that path so memories survive container recreates.

Memories are scoped by persona. While a persona is active, what it learns is kept in that persona's own vault and is private to it until you share the vault. With no persona active, memories go to the shared vault, which every persona can read. A persona recalls from its own vault, the shared vault, and any vault shared with it. Renaming or deleting a persona never deletes its vault.

Manage it in **Settings → Memory**: see what's stored, turn recall on or off (the rail toggle does the same), and check the memory status. Recall is bounded, so a large memory can't blow up the model's context window, and every recall is auditable.

Prefer a hosted memory bank? Set `MEMORY_BACKEND=hindsight` to use a self-hosted [Hindsight](../ops/memory/RUNBOOK.md) instance instead — currently experimental. Point Amanuensis at your bank's MCP endpoint (`{apiBase}/mcp/{bank}`) with a `Bearer` API key in **Settings → Memory**. Memory calls Hindsight's REST API directly for recall and retain, so use a key valid on both surfaces; see [the runbook's two-surfaces note](../ops/memory/RUNBOOK.md#two-surfaces-one-connector) if recall stops working after a key rotation.

Two optional Prompt Guard screens can check content around memory before it reaches the model, both off by default:

- **Memory recall screen**: screens memories recalled from the bank before they reach the model. Turn it on per bank in Settings → Memory with the "Screen recalled memories with Prompt Guard" switch; it needs a classifier URL configured and reachable first. Your own stated memories are never withheld; it only applies to memories that came from tools, documents, or email.
- **Tool output screen**: screens tool results before they re-enter model context. This one is environment-only, with no Settings switch, and shares the same classifier URL, token, and threshold as the recall screen.

See [Deployment Security](deployment-security.mdx#prompt-guard-screens) for the full configuration and [Memory design](../ops/memory/DESIGN.md) for how recall and retention work.
