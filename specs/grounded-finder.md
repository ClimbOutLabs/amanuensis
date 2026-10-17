# Spec: Grounded Finder (Tavily)

**Status:** approved (owner-approved feature, lands before the Oct 22 freeze)

## Problem

Maya asks "Find me an English-speaking doctor near me". Today the model can search, but it answers from snippets, can invent a phone number or opening hours, and gives no way to check where a fact came from.

## Solution

Aman runs one Tavily search, then one batched Tavily extract on the 2 or 3 best result pages. It fills a fixed place card per result (name, address, languages, hours, price, phone, source link, time fetched), and drops cited pins on the map. Each pin card shows only the fields it found, plus "from <site>, <time>" with a link.

A run costs about 3 Tavily credits: an advanced search (2) plus one extract of up to 5 pages (1).

## Verified Tavily facts

Read from Tavily's official docs on 2026-10-17 (docs.tavily.com):

- `POST https://api.tavily.com/search`: `query`, `search_depth` (`basic`, `advanced`, `fast`, `ultra-fast`), `max_results` (0 to 20), `include_answer`, `include_raw_content`. Results carry `title`, `url`, `content`, `score`.
- `POST https://api.tavily.com/extract`: `urls` (1 to 20), `extract_depth` (`basic`, `advanced`), `format`, `timeout` (1 to 60 s). Results carry `url`, `raw_content`; per-URL failures are in `failed_results`, so both arrays are read even on HTTP 200.
- Credits: search `basic` 1, `advanced` 2. Extract basic: 1 credit per 5 successful pages; advanced: 2 per 5. Failed pages are free. Free plan: 1,000 credits a month.
- Auth: `Authorization: Bearer <key>`. Keyless: send `X-Tavily-Access-Mode: keyless` instead. Keyless works for `/search` and `/extract` only, is free and rate limited, and the docs give no number. A valid key sent with the keyless header wins.
- Errors: 401 missing or bad key, 429 too many requests (`Retry-After`), 432 plan limit, 433 pay-as-you-go limit.

## Design Decisions

**Tavily is a search provider, chosen the existing way.** The Tavily preset is already in the connector catalog with `search_tools`. Choosing it as the web search provider (next to the keyless Parallel default) is the selection; nothing new is added to settings, the database or the OpenAPI. The server mounts one in-process Tavily client for that connector instead of the remote MCP connection, so the tools are `tavily_search` and `tavily_extract`, the same names the preset already lists.

**One Tavily client.** A single module owns request building, auth, timeouts, size caps, error wording and the credit count. Redirects are refused.

**The key is the one set in Settings.** It is read from the connector's saved `Authorization` header. A missing key, or the preset's untouched placeholder, means keyless, which is used only for search and extract. The key never appears in a card, a log, an audit row or a tool result.

**Same approval and guard.** Both tools run through the existing search-provider path: the Ask / Run without asking setting, the outbound secret guard, the 20-search loop breaker, held-for-owner in scheduled runs, the Searched chip and the audit row. Extract may name only URLs the search of this turn returned, so a model cannot compose a fetch. When a call asks, the card shows the exact query or URL list, the destination `api.tavily.com`, the endpoint, and the credits it will use (or "free, no key" when keyless).

**Pages are untrusted.** Tool results mark page text as untrusted, and the read-content screen the host already applies to tool output applies here too. Page text never gives instructions.

**Grounding is checked by the server, not trusted from the model.** `tavily_extract` stamps each page with the time it was fetched and keeps the text in a small server memory (URL keyed, bounded, expires in 30 minutes). The pin tool `render_places` keeps a field only when its value is found in that page's text; a field it cannot find is dropped and the card says nothing about it. The source link must be a page that was extracted. The fetch time is the server's, never the model's.

**Pins use the maps tool family.** `render_places` is a third maps tool, Tier 3 on every call like `render_map`: the card lists the addresses sent to the geocoder host and the tile host. It reuses the maps geocoder, limiter and cache. The maps result schema gains one shape, `places`, rendered by the same MapCard as a multi-pin view; there is no second schema.

**Calendar.** The model may pass the places it found in the user's calendar as `calendar_locations` (text). A pin whose name or address matches one is marked "already in your calendar"; it is never dropped.

## Tool contract

```typescript
tavily_search(params: { query: string })            // 1..200 chars. Advanced depth, 5 results.
tavily_extract(params: { urls: string[] })           // 1..3 URLs returned by this turn's search.
render_places(params: {
  places: Array<{                                     // 1..3
    name: string;                                     // 1..128
    address: string;                                  // 1..128
    languages?: string; hours?: string; price?: string; phone?: string; // each 1..128
    source_url: string;                               // a page that tavily_extract returned
  }>;
  calendar_locations?: string[];                      // 0..10, each 1..128
}) -> {
  status: "ok";
  places: Array<{ name; address; languages; hours; price; phone; source_url; source_site;
                  fetched_at; lat; lng; already_in_calendar: boolean }>;  // missing fields are null
  attribution: string;
}
```

Every bound is 128 or under and no field uses a regex, as for the other maps tools.

## Privacy

- Sent to `api.tavily.com`: the search text, then the page URLs. Tavily also sees the server's IP, and with a key, the account. Nothing else is sent.
- Sent to the maps geocoder: the addresses found on the pages, only after the user approves the pin card.
- Page text stays in server memory for 30 minutes and is never written to the database or logs.
- Keyless use sends no account or key. If the user objects, they can pick another provider or set searches to Ask.

## Testing

All tests use synthetic data: invented places, fake keys, and a recorded Tavily response stored in the test folder. CI never calls Tavily.

- Client: request shape, auth header with a key, keyless header without one, redirect refusal, size cap, 401, 429, 432, 433 and timeouts each give one plain sentence, credits counted from the docs rules.
- Source: both tools are search tools, extract refuses a URL the search did not return, results are marked untrusted.
- Classifier: Ask setting, guard trip and unreturned URL each produce a card with query or URL list, `api.tavily.com`, endpoint and credits; silent otherwise.
- Grounding: a field not in the page text is dropped, a foreign source URL is refused, the fetch time is the server's, a hostile page cannot change the schema.
- Maps: `render_places` is Tier 3 with the addresses on the card, one limiter, calendar match marks and keeps the place.
- UI: journey with a scripted stub model and the recorded response: card, approve, pins with sources, light and dark.

## Out of Scope

- Tavily crawl, map and research endpoints.
- A second geocoder, or a place database.
- Choosing a provider anywhere but the existing connector setting.
- Reading the calendar from the server (the model reads it through the user's calendar connector).
