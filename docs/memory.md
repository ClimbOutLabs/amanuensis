# How memory works

This page explains where Aman keeps memories, how it picks what to save, and how it finds them again. To read, change or forget your memories, see [Memory](../packages/trueforge/guide/topics/memory.md).

## Memories are ordinary files

Aman saves memories as plain text files in Markdown, a simple text format. They live in a memory folder on the computer that runs Aman. By default that is `./data/memory`, next to the server. There is no separate database: you can open the files and read them.

The folder is set by `MEMORY_MARKDOWN_DIR`, relative to the server's working folder. **Settings**, **Memory**, **Settings** shows the folder this Aman uses.

!!! warning "Keep the memory folder safe"

    If you run Aman with Docker, store the memory folder on a persistent volume. Without one, your memories and the downloaded search helper disappear whenever the container is recreated.

## What Aman saves

Memory is on by default. Before every reply, Aman looks up the memories that fit what you asked. After every finished turn, it saves what is worth keeping. The model never has to remember to do either.

With **Turn summaries** on, Aman keeps only lasting facts: facts about you, plans, preferences, decisions and anything you asked it to remember. A turn with nothing lasting saves nothing. If a summary can't be made, nothing is saved for that turn, and the **Memories** tab says so.

With **Turn summaries** off, Aman saves each turn word for word. The summaries use the **Summarization model** from [A model for each job](model-roles.mdx), and each one costs an extra model call.

## How Aman finds memories

Aman searches your memories by meaning, not just by matching words. So "where did we stay in Paris" finds the hotel note even if it says "Hotel Lumiere" and never mentions Paris.

To do that, Aman downloads a small helper model once, about 120 MB. The download starts in the background when the server starts, so it is usually done before you need it. There is nothing to install or click.

- After that one download, memory search works fully offline, and everything stays on your server.
- The helper model is kept inside the memory folder, so the two travel together.
- If the download can't finish, Aman finds memories with keywords instead and keeps retrying in the background.

**Settings**, **Memory**, **Settings** shows the helper's state: Starting, Downloading, Indexing, Ready or Keywords only.

Recall is limited in size, so a large memory can't crowd out the conversation. Each recalled block is recorded in that turn's events as `aman.memory.recall`, so you can check what the model saw.

## Personas and shared notes

Memories are kept per persona, in separate vaults (folders of notes).

- While a persona answers, what it learns goes into that persona's own vault. It stays private to that persona until you share it.
- With no persona active, memories go into the shared vault, which every persona can read.
- A persona recalls from its own vault, the shared vault, and any vault shared with it on the **Sharing** tab.
- Renaming or deleting a persona never deletes its vault.

## Incognito chats

An incognito chat reads memory but never writes to it. Aman recalls as usual, but saves nothing from the chat, in any persona, and the chat never joins past-chat search. See [Privacy](privacy.md#incognito-chats).

## Searching past chats

Past-chat search is off until you turn it on in **Settings**, **Memory**, **Settings**. While it is off, nothing from your chats is added to the search.

- When you turn it on, Aman adds your earlier chats in the background, then adds each new chat as it finishes.
- When you turn it off, everything it added is removed.
- It covers what you typed and Aman's final replies. The current chat is never included.

The search follows the same rule as memory. A persona finds its own chats, chats with the main assistant, and chats of personas whose vault is shared with it. A chat with a persona whose vault is not shared stays out.

### Searching your chats yourself

The **Search chats** box at the top of your chat list matches titles first. Below them, under **In messages**, come chats where a message holds your words, each with a short piece of that message. This covers all your own chats, whichever persona answered, because you can already open every chat in your list. It needs the past-chat search switch: while that is off, the box matches titles only.

A message matches when it contains every word you searched for, as a whole word. Small filler words such as "the" are ignored. "Trip", "trips" and "tripped" count as the same word, while different words such as "made" and "mad" stay apart.

## Safety screens

Two optional Prompt Guard screens can check content before it reaches the model. Both are off by default.

- **Recall screening** checks memories recalled from the bank. Turn it on in **Settings**, **Memory**, **Settings**. It needs a classifier URL set up and reachable first. Your own stated memories are never held back; it only applies to memories that came from tools, documents or email.
- **Tool-output screening** checks tool results before they go back to the model. It shares the same classifier URL, token and threshold as recall screening.

The settings are `MEMORY_SCREEN_ENABLED`, `MEMORY_SCREEN_URL`, `MEMORY_SCREEN_AUTH_TOKEN`, `MEMORY_SCREEN_THRESHOLD`, `TOOL_OUTPUT_SCREEN_ENABLED` and `TOOL_OUTPUT_SCREEN_TIMEOUT_MS`. See [Deployment security](deployment-security.mdx#prompt-guard-screens) for the full setup.

## Using Hindsight instead

??? note "Hosted memory bank (experimental)"

    Set `MEMORY_BACKEND=hindsight` to use a self-hosted [Hindsight](../ops/memory/RUNBOOK.md) instance instead of Markdown files. Point Aman at your bank's MCP endpoint (`{apiBase}/mcp/{bank}`) with a `Bearer` API key in **Settings**, **Memory**.

    Memory calls Hindsight's REST API directly for recall and saving, so use a key that works on both. If recall stops working after you change the key, see [the runbook's two-surfaces note](../ops/memory/RUNBOOK.md#two-surfaces-one-connector).

    With Hindsight, the Markdown folder, the helper model and the notes above about files don't apply.

For the full design of recall and saving, see [Memory design](../ops/memory/DESIGN.md).
