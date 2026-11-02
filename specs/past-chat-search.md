# Spec: Past Chat Search

**Status:** approved

## Problem

People remember that they talked about something but not which chat it was in. The assistant can already search earlier chats when asked (the `search_past_chats` tool). The "Search chats" box in the sidebar only matches chat titles, though, and that box is where people look first. A search for a word said inside a chat finds nothing unless the word is also in the title.

## Solution

The sidebar "Search chats" box searches the words inside messages too, using the same index and the same word rule as the assistant's tool. Title matches stay as they are. Message matches show up under them with a short snippet, and clicking one opens that chat.

## What is already built

- **The index.** One row per searchable message: what the person typed and the assistant's final replies. Tool calls, tool output, attachments and host-wrapped text stay out.
- **The word rule.** Text is put in NFKC form and split into lowercase words. Filler words are dropped and English words are reduced to their Porter stem. A message matches when it holds every search word as a whole word.
- **The switch.** "Let <assistant> search your past chats when you ask" in Settings, then Memory, is off by default. While it is off, nothing is indexed. Turning it on adds earlier chats in the background, and turning it off removes everything that was added.
- **The assistant's tool** follows the memory rule for personas. A persona finds its own chats, chats with the main assistant, and chats of personas whose vault is shared with it.

## The sidebar search

- **Whose chats.** Only the person's own chats in this tenant. Another person's chats never match.
- **No persona filter.** The persona rule exists to keep one assistant from reading another persona's private chats. In the sidebar, the person is the reader, and they can already open every chat in their list. So the sidebar searches all of their chats, whichever assistant answered.
- **When the switch is off.** There is no index to search, so the box matches titles only, as it does today. Under the results it shows one line: "To search inside messages, turn on past-chat search in Settings, then Memory."
- **Results.** Title matches come first, as today. Then up to 20 chats whose messages match, newest first, each shown once with its title, date, and a snippet of at most 300 characters opened near the first matching word. A chat that already matched by title is not listed twice.
- **Typing.** The request waits until typing pauses (300 ms) and needs at least one word that is not a filler word. A newer search cancels an older one still in flight.

## Server

- A new route, `GET /api/v1/user/chat-search?query=...&limit=...`, returns `{ data: { search_enabled, hits: [{ session_id, title, snippet, matched_at }] } }`. It reads the switch first. When the switch is off it returns no hits with `search_enabled: false`, so the sidebar can show its hint.
- The store's `searchChatHistory` input changes its persona filter to a discriminated union: `{ kind: 'all' }` for the sidebar, and `{ kind: 'only', persona_ids }` for the assistant's tool. All three stores (in-memory, SQLite, Postgres) and the store contract suite change together.
- Every hit is re-checked against its chat record before it is returned, the same as the tool does.

## Privacy

- **What data is involved:** the person's own messages and the assistant's final replies, already indexed only while the switch is on.
- **Where it flows:** from the local database to the person's own browser, over the app's existing authenticated API. Nothing goes to a model or any outside service. A sidebar search is not sent to the assistant.
- **What stays on the device:** everything. The index lives in the same database as the chats, and deleting a chat removes its rows.

## Testing

- The store contract suite covers the `all` persona filter on all three stores: it returns every persona's chats for the owner and never another person's.
- A route test checks that the search returns the person's own matches, returns nothing with `search_enabled: false` while the switch is off, and refuses a blank query with a plain message.
- UI tests check that title matches come first, a chat is listed once, the snippet shows, the hint shows while the switch is off, and a stale search is dropped.
- Tests use synthetic data only, never a person's real chats.

## Out of scope

- Searching attachments, tool output, or files.
- Ranking by relevance. Results are newest first.
- Changing the assistant's tool or the persona rule it follows.
