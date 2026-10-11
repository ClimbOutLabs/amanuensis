# Spec: Web Search Policy

**Status:** draft

## Problem

Web search is the most common outbound action an agent takes, and today every search stops for an approval card. A search provider's tool is open-world, so Sentinel classifies it Tier 3 ("unrecognized tool") and asks every time. That makes research turns tedious and makes scheduled runs unusable, since nobody is there to approve.

The card is not the real protection anyway. The risk in a search is the query text: it leaves the machine, and a model that has read a secret, a key, or a card number can paste it into a query. Asking the user to approve each harmless query trains them to click through the one that matters.

## Solution

Let the user designate one connector as their search provider. Its search tool then runs without asking, in interactive chats and scheduled runs, behind a deterministic host-side outbound secret guard. When the guard trips, the call does not run silently: an interactive chat shows the normal approval card with the exact query, and a scheduled run denies the call, records it in the audit log, and continues.

Parallel's free keyless hosted MCP (`search.parallel.ai/mcp`) is the default search provider and ships as a catalog preset. Any other connector can hold the role instead.

Everything is enforced by the server (classifier, tool executor, host state). Nothing depends on the model behaving.

## Design Decisions

**The role is a connector setting, never a tool name.** A `search_provider` flag on the connector manifest, like the memory-provider role. A tool called `web_search` on any other connector still asks. At most one connector holds the role. Only the designated connector's tools can run silently, and only when they are not flagged destructive or non-read-only and do not match the existing destructive, install, or external-service escalations.

**A user setting switches searches back to Ask.** The setting lives with the other per-user Sentinel preferences. The default is "Run without asking", and it applies to the designated provider only. It never relaxes any other tool.

**One canonical outbound secret guard.** A single host-side module, reused later for maps and URL fetch. Deterministic, no model judgment. It reads every string in the call's arguments and blocks when any of these holds:

- an exact match of any server-held secret: model provider API keys, connector OAuth tokens and client secrets, `TRUEFORGE_API_KEY`, and other configured secret values;
- a private key block, a JWT, or a common key prefix (AWS, GitHub, OpenAI, Anthropic, Slack, Nebius, and similar);
- a base64 or hex run of 20 characters or more;
- a password label pattern (`password:`, `pwd=`, `passcode`, and similar) followed by a value;
- a payment card number that passes Luhn;
- more than 200 characters in total.

The guard is tuned so ordinary queries with numbers, dates, and names pass.

**Guard trip behavior depends on who is watching.** In an interactive chat the call asks, and the approval card shows the exact query. In a scheduled run the call is denied before it runs, an audit row records the denial and the rule that fired (never the query text), and the run continues.

**Loop breaker.** After 20 silent searches in one turn, the next one asks (or is denied in a scheduled run). The count lives in host state for the turn.

**Links.** A URL fetch through the designated provider is silent only when the URL exactly matches one returned by a search result in this turn. The host keeps that set from the provider's results. Any model-composed or modified URL asks. The same rule means a search query that carries a URL also asks.

**Visibility.** Every silent search shows a "Searched: <query>" chip in the chat and writes a Sentinel audit row. The chip is driven by a server-stamped field on the tool call, not inferred by the UI.

**Silent means audited.** The audit row is written once, at dispatch, like the other standing-trust runs.

## Scope

- `search_provider` role on the remote MCP connector manifest, with the single-holder rule, across core, server, SDK, and UI
- The Parallel keyless catalog preset marked as the search provider
- Per-user "Searches: Run without asking / Ask" setting (default Run without asking), in the Sentinel settings API, store, and settings UI
- The outbound secret guard module in core, with a host-supplied secret source
- Classifier path for the designated provider, the per-turn host state (silent count, search-result URL set), and scheduled-run denial with an audit row
- The "Searched: <query>" chip and the audit row for silent searches

## Privacy

- The only data that leaves the machine is the search query (and, for fetch, a URL the search provider itself returned). The guard exists to keep secrets, keys, card numbers, and long pasted content out of it.
- Server-held secrets are read only to compare against outgoing text. They are never logged, never sent to the model, and never placed in an audit row or a card.
- The audit row for a silent search stores the query text, which the guard has already cleared. The audit row for a denied search stores only the rule that fired, because a tripped query may contain the very secret the guard caught.
- An approval card for a tripped query shows the exact text to the user who owns the session, so they can see what the model tried to send. That text is part of the persisted turn like any other tool call.
- Parallel's keyless endpoint sees the query and the server's IP. Users who object can pick another provider or switch searches to Ask.
- The per-turn URL set and silent count are in-memory host state, dropped with the turn.

## Testing

- All tests use synthetic data: fake keys, fake tokens, and test card numbers built for the test. No real credentials or user data.
- Each guard rule, including the false positives that must pass (ordinary queries with numbers, dates, names, version strings, and file paths).
- Silent search for the designated provider only; a non-designated search tool still asks.
- A scheduled run denies on a guard trip, writes the audit row, and the run continues.
- The loop breaker at 20, interactive and scheduled.
- Exact-URL fetch is silent while a modified URL asks.
- The audit row and the chip.
- The user setting set to Ask makes the designated provider ask.
- Settings, connector role, and catalog preset covered through the API and UI test suites; OpenAPI and SDK regenerated from the repo scripts.

## Out of Scope

- Maps and URL-fetch tools beyond the designated provider's own fetch. They reuse the guard module later, under their own specs.
- Model-judged or semantic leak detection. The guard stays deterministic.
- Screening search results for prompt injection (separate concern).
- Per-query allow lists or per-domain rules.
- Making any non-designated connector's tools silent.
