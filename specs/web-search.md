# Spec: Web Search Policy

**Status:** draft

## Problem

Web search is the most common outbound action an agent takes, and today every search stops for an approval card. A search provider's tool is open-world, so Sentinel classifies it Tier 3 ("unrecognized tool") and asks every time. That makes research turns tedious and makes scheduled runs unusable, since nobody is there to approve.

The card is not the real protection anyway. The risk in a search is the query text: it leaves the machine, and a model that has read a secret, a key, or a card number can paste it into a query. Asking the user to approve each harmless query trains them to click through the one that matters.

## Solution

Let the user designate one connector as their search provider. Its search tool then runs without asking, in interactive chats and scheduled runs, behind a deterministic host-side outbound secret guard. When the guard trips, the call does not run silently: an interactive chat shows the normal approval card with the exact query, and a scheduled run holds the call for its owner, records the hold in the audit log, and continues.

Parallel's free keyless hosted MCP (`search.parallel.ai/mcp`) is the default search provider and ships as a catalog preset. Any other connector can hold the role instead. A one-time data migration designates a connector saved before the setting existed when it matches a search preset by endpoint and none of the tenant's connectors carries any explicit `search_provider` value; an explicit `false` is the record of "turned off". A designated connector with no stored `search_tools` uses its preset's list at run time.

Everything is enforced by the server (classifier, tool executor, host state). Nothing depends on the model behaving.

## Design Decisions

**The role is a connector setting, never a tool name.** A `search_provider` flag on the connector manifest, like the memory-provider role. A tool called `web_search` on any other connector still asks. At most one connector holds the role. Only the designated connector's tools can run silently, and only when they are not flagged destructive or non-read-only and do not match the existing destructive, install, or external-service escalations.

**A user setting switches searches back to Ask.** The setting lives with the other per-user Sentinel preferences. The default is "Run without asking", and it applies to the designated provider only. It never relaxes any other tool.

**One canonical outbound secret guard.** A single host-side module, reused later for maps and URL fetch. Deterministic, no model judgment. It reads every string in the call's arguments and blocks when any of these holds:

- an exact match of any server-held secret: model provider API keys, connector OAuth tokens and client secrets, `TRUEFORGE_API_KEY`, and other configured secret values;
- a private key block, a JWT, or a common key prefix (AWS, GitHub, OpenAI, Anthropic, Slack, Nebius, and similar);
- a base64 or hex run of 20 characters or more;
- a password or credential label (`password:`, `pwd=`, `passw0rd`, `token=`, `api key:`, and similar) followed by a value;
- a payment card number that passes Luhn;
- more than 200 characters in any one string, or more than 1,000 in all.

Arguments the catalog declares as a provider's plumbing (`search_plumbing_fields`, such as `session_id` and `model_name`) are not user text: they stay out of the search chip and the length rule, every other rule still reads them, and a hex or base64 value there passes the encoded-run rule only when the provider itself returned it earlier in the turn.

The guard is tuned so ordinary queries with numbers, dates, and names pass.

**Guard trip behavior depends on who is watching.** In an interactive chat the call asks, and the approval card shows the exact query. In a scheduled run the call is held before it runs and listed under "Needs your OK" with the exact query; an audit row records the hold, and the run continues. The owner's later answer runs the stored call once or drops it.

**Loop breaker.** After 20 silent searches in one turn, the next one asks (or is held for the owner in a scheduled run). The count lives in host state for the turn. An approval resumes the conversation as a new turn with a fresh count, which is accepted: each resume needs a person to approve a call, and the guard still reads every query.

**Links.** A URL fetch through the designated provider is silent only when the URL exactly matches one returned by a search result in this turn. The host keeps that set from the provider's results. Any model-composed or modified URL asks. The same rule means a search query that carries a URL also asks.

**Visibility.** Every silent search shows a "Searched: <query>" chip in the chat and writes a Sentinel audit row. The chip is driven by a server-stamped field on the tool call, not inferred by the UI.

**Silent means audited.** The audit row is written once, at dispatch, like the other standing-trust runs.

**The role never replaces a missing hint on its own.** A tool on the designated connector runs without asking only when the server declares it `readOnlyHint: true`, or when the connector's catalog preset lists it in `search_tools`. The server fills that list from the shipped catalog by the connector's address whenever the connector is saved as the provider, and replaces any value a client sends, so only the operator's catalog can widen it. Every other tool on the connector follows the normal Sentinel path, so designating a connector that can write (GitHub, say) leaves its unannotated and write tools asking. A tool that declares itself destructive or not read-only, or whose name falls in an existing escalation class (delete, install, send, post, and similar), still asks even when listed. The approval selectors the user set on the agent still apply on top; the default selectors' gate on missing annotations is waived only for a listed tool, and only while the list is the default. The connection to the provider refuses redirects, so a silent search cannot be forwarded to another host.

**The guard reads normalized text.** Before any rule runs, text is folded (NFKC, combining marks, zero-width and other format characters, a few look-alike letters) and percent-decoded once; the original spelling is scanned as well. A server-held secret is compared in compact form (letters and digits, any case) in its stored, URL-escaped, base64 and hex spellings. Server secrets shorter than 8 characters are ignored, since they would flag ordinary words. The guard also reads the text of the turn's earlier silent searches, so a secret split over searches is seen whole; searches of one batch are admitted one at a time so they cannot slip past each other.

## Scope

- `search_provider` role on the remote MCP connector manifest, with the single-holder rule, across core, server, and UI (the SDK and OpenAPI follow from the Generate SDK workflow)
- The Parallel keyless catalog preset marked as the search provider, and a `search_tools` list on the Parallel, Tavily and Exa presets naming their real search tools
- Per-user "Searches: Run without asking / Ask" setting (default Run without asking), in the Sentinel settings API, store, and settings UI
- The outbound secret guard module in core, with a host-supplied secret source
- Classifier path for the designated provider, the per-turn host state (silent count, search-result URL set), and scheduled-run holding with an audit row
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
- Silent search for the designated provider only; a non-designated search tool still asks, and so does every unannotated or write tool of a write-capable connector designated as the provider.
- A scheduled run holds on a guard trip, writes the audit row, and the run continues.
- The loop breaker at 20, interactive and scheduled.
- Exact-URL fetch is silent while a modified URL asks.
- The audit row and the chip.
- The user setting set to Ask makes the designated provider ask.
- Settings, connector role, and catalog preset covered through the API and UI test suites.

## Out of Scope

- Maps and URL-fetch tools beyond the designated provider's own fetch. They reuse the guard module later, under their own specs.
- Model-judged or semantic leak detection. The guard stays deterministic.
- Screening search results for prompt injection (separate concern).
- Per-query allow lists or per-domain rules.
- Making any non-designated connector's tools silent.
