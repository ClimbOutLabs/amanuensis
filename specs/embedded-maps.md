# Spec: Embedded Maps

**Status:** draft

## Problem

Location-related queries return text-only responses. Users cannot see spatial context (where a place is, what is around it) without doing the mental mapping themselves.

## Solution

Add two model-callable tools, render_map and render_route. When the user asks to see a place or for directions between two named places, the model calls the tool, the user approves the exact place names and the hosts they go to on a Sentinel Tier 3 card, and an interactive map card renders inline in the conversation. Map tiles reach the browser only through a same-origin proxy on the server, so the app shell's remote-image block stays intact.

Model-callable tools only. No Map button. No automatic detection of the user's location. The tools run in the server process, not the sandbox.

## Design decisions

Every call asks (Tier 3). Geocoding sends place names, routing sends both endpoints, and tiles send the map viewport to third-party servers, so each call is a Tier 3 external-service action with a card, every time, in v1. No standing grant ("Always allow") and no per-chat relaxation. The classifier gets an explicit maps branch keyed on the two tool names, next to the extractor registry. The tier is not derived from MCP hints: a readOnlyHint on these tools would make them silent Tier 1 today, and the fail-closed "unrecognized tool" card names no destination and no place, which is not acceptable for data leaving the machine. Background and scheduled runs never call these tools (Tier 3 calls are held until the user is present).

The card uses the existing Tier3Card fields:

- plain_what, render_map: Send "<place_name>" to <geocoder host> to find it, then load map tiles for that area from <tile host>. With poi: Send "<place_name>" and "<poi>" to <geocoder host> to find <poi> near it, then load map tiles for that area from <tile host>.
- plain_what, render_route: Send "<from_place>" and "<to_place>" to <geocoder host>, ask <router host> for a driving route between them, then load map tiles for that area from <tile host>.
- destination: the configured hosts, comma separated, read from server config and never from params, so it is always verifiable and the destination_unverifiable fallback never fires.
- cannot_be_undone: Once the place names leave this machine they cannot be taken back.
- plain_why: agent intent, as for every other tool. recipient, amount, parsed_command: null.

Place strings on the card come from the canonical params (server-parsed, capped at 128 characters by the schema) and render as text, never as markup. The approval covers the initial map and the user's own panning and zooming of that card, which fetch more tiles through the proxy.

Tiles go through a server proxy. The app shell ships img-src 'self' data: blob: and chat images never auto-load, because a model-authored image URL can carry private data to a third-party host. Tiles are remote images, but their URLs are computed by the server from geocoded coordinates, the model never writes them, and the user approved the place on the card, so the channel the block exists for is closed. The CSP is not widened. The server serves GET /api/maps/tiles/{z}/{x}/{y}.png: it requires a human UI session and is unreachable from the agent and sandbox contexts; it validates z in 0..18 and x, y in 0..2^z-1 and rejects anything else with 400; it fetches only MAPS_TILE_URL with the template filled; it forwards only image/* bodies; it sends no cookies or Referer upstream and sets the identifying User-Agent. The browser never contacts the tile host. The proxy answers 503 while offline mode is on and when upstream fails.

Configurable endpoints, public defaults. Read through packages/trueforge/src/config.ts: MAPS_GEOCODER_URL (default https://nominatim.openstreetmap.org), MAPS_ROUTER_URL (default https://router.project-osrm.org), MAPS_TILE_URL (default https://tile.openstreetmap.org/{z}/{x}/{y}.png), MAPS_USER_AGENT (default Amanuensis/<version> (+<repository url>)). Each URL must be http(s), parsed at boot and failing fast otherwise, as PUBLIC_BASE_URL does. The card shows the configured hosts, so a self-hosted stack shows its own names. The public defaults are shared community services: the OSM tile policy forbids heavy use and distributed apps without permission, Nominatim allows at most one request per second and requires an identifying User-Agent and cached results, and the OSRM demo server offers no guarantees. v1 states this in the data-flow doc; a self-hosting compose profile gets its own spec.

Usage discipline and caching. One in-process limiter per instance: geocoder and router at most one request per second each, calls queued in order, 10 s timeout per upstream request. Tile proxy: at most 4 upstream fetches in flight and at most 128 upstream tiles per card per minute (the card id is the tool call id); above that the proxy answers 429 and the card shows its blocked state. Geocode results are cached in memory keyed by the exact request, 500 entries, 24 h TTL. Tiles are cached in memory by z/x/y, 2,000 entries, honouring upstream Cache-Control and Expires up to 7 days. Caches hold no user location, live in process memory only, and are gone on restart.

No user location, ever. The model passes place names as the user gave them; the tools geocode. The model never passes coordinates. The card never calls navigator.geolocation or Leaflet locate() and has no locate control. POI search and routing areas always come from a named place.

Offline mode. render_map and render_route are added as true to the hand-curated FIRST_PARTY_REQUIRES_NETWORK registry in packages/trueforge-core/src/core/permissions/networkRequirements.ts; tools do not self-declare. While offline the tools are filtered from the model's tool list, a stale call is auto-denied with offline_mode, the tile proxy refuses, and existing cards render their blocked state. If the user asks for a map or directions while offline, the model says plainly that maps need a network connection. No cached-tile fallback in v1.

## Tool contract

Input schemas are .strict() zod objects. Every bound (maxLength, maxItems, numeric ranges) is 128 or under and no field uses a regex pattern, because the xgrammar engine crashes on larger bounds and on lookahead. Results are JSON text.

```typescript
render_map(params: {
  place_name: string;      // 1..128 chars. "Paris", "Eiffel Tower", "1600 Amphitheatre Parkway"
  poi?: string;            // 1..64 chars. "coffee shop", "pharmacy": POI search near the place
  zoom?: number;           // integer 1..18, default 13
}) -> {
  status: "ok";
  resolved_name: string;   // top geocoder match, e.g. "Paris, France"
  address: string | null;  // geocoder display address, shown on the card
  lat: number;
  lng: number;
  zoom: number;
  pins: Array<{ name: string; lat: number; lng: number }>;  // 0..5, empty unless poi is given
  attribution: string;     // "© OpenStreetMap contributors"
}
render_route(params: {
  from_place: string;      // 1..128 chars. "Madrid"
  to_place: string;        // 1..128 chars. "Barcelona"
}) -> {
  status: "ok";
  from: { resolved_name: string; lat: number; lng: number };
  to: { resolved_name: string; lat: number; lng: number };
  distance_km: number;
  duration_min: number;
  traffic?: boolean;       // true when duration includes live traffic
  route_geometry: string;  // encoded polyline, precision 5, at most 8,000 chars
  attribution: string;
}
```

There is no card id in the result: the renderer keys on the tool call itself.

Geocoding. GET {MAPS_GEOCODER_URL}/search?q=<place>&format=jsonv2&limit=1&addressdetails=1. With poi, a second request at least one second later: q=<poi>&viewbox=<bounding box of the resolved place>&bounded=1&limit=5. Nominatim is a geocoder, not a POI index, so category queries can return few or no hits; zero hits is not an error.

Routing. GET {MAPS_ROUTER_URL}/route/v1/driving/{lng1},{lat1};{lng2},{lat2}?overview=simplified&geometries=polyline. distance (m) and duration (s) are converted to km and minutes, rounded to one decimal. If the encoded geometry exceeds 8,000 characters the tool thins points evenly, keeping both endpoints, so the result never trips the oversized-result screens and the card always has a drawable line. Driving profile only in v1. Origin coordinates are rounded to 3 decimal places (about 100 m) before the request leaves the server; the destination is not rounded.

Routing provider. Traffic-aware routing comes from a provider still being chosen. The routing provider sits behind one interface in config.ts (MAPS_ROUTER_URL plus a provider id), with OSRM as the first implementation. The result carries duration_min and an optional traffic boolean that says whether the duration includes live traffic.

Errors. Returned as error tool results with a JSON body { status: "error", code, field?, service? }. No map card renders for any error; the model explains in plain text.

| code                | when                                                                     | extra field                                   |
| ------------------- | ------------------------------------------------------------------------ | --------------------------------------------- |
| not_found           | geocoder returned no match                                               | field: from_place or to_place on render_route |
| no_route            | both endpoints geocoded, router answered NoRoute                         |                                               |
| service_unavailable | upstream unreachable, timed out, or answered a non-2xx other than 429    | service: geocoder or router                   |
| rate_limited        | upstream answered 429, or the local queue could not run the call in 10 s | service: geocoder or router                   |

POI zero-match is not an error: the tool returns the place with pins: [], the card renders with the place pin, and the model says it found the place but no matching POIs nearby.

## Tool descriptions given to the model

"Render an interactive map with a pin for a named place. Pass the place name as the user gave it (e.g. 'Paris', 'Eiffel Tower'); never pass coordinates. The tool geocodes the name and returns an inline map card; the user is asked to approve each call. Use when the user explicitly asks to see a place on a map, asks where a place is, or asks for a kind of place near a named place."

"Render a route map between two named places. Pass both place names as the user gave them (e.g. from_place 'Madrid', to_place 'Barcelona'); never pass coordinates. The tool geocodes both endpoints, routes by road, and returns an inline map card with the route, distance, and duration; the user is asked to approve each call. Use only when the user has named both the origin and the destination; there is no current-location mode."

## Call rules for the model

Call render_map when:

- The user asks to see a place: "show me X", "show me X on a map", "where is X", "map of X". "Show me Paris" works; the words "on a map" are not required.
- The user asks for POIs near a named place: "coffee shops in Paris", "pharmacies near the Eiffel Tower". The area comes from the named place, never from the user's location.

Call render_route when:

- The user asks for directions between two named places: "directions from Madrid to Barcelona", "how do I get from X to Y", "route from X to Y".

Do NOT call when:

- A location is mentioned in passing ("my Paris trip was great"). No map appears uninvited.
- "Show me X" where X is clearly not a place ("show me the quarterly report"). The tool is for places.
- The user asks for "nearest X" without naming a place. The model asks which area to search, since it does not track the user's location.
- The user asks for directions without a starting point ("directions to Barcelona", "how do I get there"). The model asks where from.
- The user gives a user-centric shorthand as the origin ("from home", "from my place"). The model treats these as unnamed and asks for a named starting point. It never resolves "home" to a memorized address.

Each call is one card and one approval. If the user names several places ("Paris and London"), the model calls render_map once per place; each call asks.

## Key journeys

Doctor's appointment. The user has an appointment with a location in their calendar and asks: "How do I get to my doctor's appointment tomorrow?"

- The model reads the calendar and finds the appointment and its location ("Hospital Clinic, Barcelona, 2pm").
- The model does not track the user's location, so it asks: "Where are you coming from?"
- User: "From Placa de Catalunya." The model calls render_route(from_place="Placa de Catalunya", to_place="Hospital Clinic, Barcelona").
- The approval card shows both strings verbatim, including the calendar-derived one, and the hosts they go to. The user approves.
- A MapCard renders with the route, distance, and duration.
- The maps spec does not depend on the calendar implementation; a calendar location is a named place like any other. Smart departure times stay out of scope.

POI near an appointment. "Find parking near Hospital Clinic": the model calls render_map(place_name="Hospital Clinic, Barcelona", poi="parking").

## Ambiguity

The geocoder returns ranked matches. v1 uses the top result. The MapCard shows the resolved name prominently (e.g. "Paris, France") so a wrong pick is visible at a glance. No disambiguation UI in v1.

## UI component

MapCard is a tool-result renderer in @truefoundry/trueforge-ui, selected by tool name in the tool-call container the way the sandbox and sub-agent cards are. It is not an OpenUI component: the model never authors map markup.

- Leaflet from npm with its stylesheet bundled into the package; nothing from a CDN. Markers are circleMarker (no image assets). The tile layer URL is the same-origin proxy path and nothing else.
- Layout: fills the message width; map height clamp(12rem, 50vw, 20rem); rem units and theme tokens for the frame, caption, and attribution in light and dark; standard tiles in both themes (no tile filter in v1). Phone: drag and pinch zoom on; scroll-wheel zoom off until the map is clicked or focused so the page keeps scrolling; zoom buttons at least 2.75rem.
- Header: resolved name (bold) and address. Route card: both endpoint labels, the polyline, the map fitted to the route bounds, and a caption "621 km, about 6 h 10 min". POI pins and route lines never share a card.
- Attribution always visible, --text-xs: "© OpenStreetMap contributors" linking to the OSM copyright page, plus "Search: Nominatim" or "Routing: OSRM" as used. Links open in a new tab.
- Untrusted text: resolved_name, address, and pin names are third-party data. Popup content is set as a DOM text node; strings are never passed to bindPopup.
- States: loading (after approval, while the tool runs); ok; blocked (the proxy answered 503 or 429, or offline mode is on): the card keeps the header, address, and coordinates and shows a sunk panel "Map tiles unavailable" with the reason and a Retry button. Retry is one user-initiated fetch; the card never auto-retries. Error results render no card; the tool-call card shows the failure tone and the model explains in text.
- Cards re-rendered from history request tiles through the proxy again, mostly from cache, under the original approval.

## Privacy

What leaves the machine, and to where:

- Place names typed by the user, or taken from the user's calendar, go to the configured geocoder host, with the POI text when given.
- Both route endpoints' coordinates go to the configured router host.
- The map viewport (tile coordinates) goes to the configured tile host, from the server, with the configured User-Agent and no cookies or Referer.

What never leaves: the user's own location (never collected), memory, calendar data beyond the one location string the user approved on the card, browser identity (the browser never contacts a map host). Nothing is sent before the user approves the card. Every call is recorded in the Sentinel audit log as approved, denied, or ran, with the card's plain_what as its description; individual tile fetches are not logged. This section is the feature's data-flow doc; the privacy dashboard links it when it ships.

## Scope

- Model-callable render_map and render_route tools, Tier 3 on every call, with the maps card text above.
- POI search around a named place, up to 5 pins.
- Routing between two named places, driving profile, with distance and duration.
- Same-origin tile proxy, configurable endpoints, rate limiting, in-memory caches, attribution.
- Offline mode wiring through the network-requirements registry.

## Out of scope

- Real-time location tracking; "nearest X" or "directions to X" without a named start.
- Turn-by-turn navigation UI; smart departure times (own spec if built).
- Disambiguation UI and alternative matches; multi-pin single cards.
- Standing or per-chat approval relaxations for maps.
- Persistent or shared caches; cached-tile fallback while offline.
- Dark tile styling; self-hosting compose profile (own spec).

## Testing

Synthetic place names only; no real user location or calendar data. Tests stub the geocoder, router, and tile upstreams; CI never calls the public services.

- Classifier: render_map and render_route are Tier 3 with the maps card text, the configured hosts as destination, and the place strings verbatim; a readOnlyHint on either tool does not lower the tier; offline mode auto-denies a stale call with offline_mode and the tools are absent from the model's list.
- Schemas: every bound is 128 or under and no field has a regex pattern; place_name over 128 chars and zoom of 0 or 19 are rejected before any upstream call.
- Tile proxy: rejects z outside 0..18 and x, y outside range with 400; forwards no cookies or Referer; drops a non-image upstream body; answers 503 while offline; answers 429 above 128 tiles per card per minute; the rendered tile URLs are same-origin so the app shell CSP is unchanged.
- Limiter: two geocode calls in one second run one second apart; a 429 upstream becomes rate_limited with service.
- "Show me Paris on a map" renders a MapCard pinned in France labeled "Paris, France" with the attribution line.
- "Show me Xyzqpl on a map" gets a plain-text explanation and no card.
- Malicious resolved_name, address, and pin names render as inert text.
- "Coffee shops in Paris" renders up to 5 POI pins near Paris; "find parking near Paris" with zero hits renders the Paris card with no pins and a plain-text note.
- "Nearest coffee shop" and "how do I get to Barcelona" each get a plain-text ask, not a map.
- "Directions from Madrid to Barcelona" renders the route, distance, and duration; "from Xyzqpl to Barcelona" names Xyzqpl as the place it could not find; NoRoute and an unreachable router degrade to plain text; a geometry over 8,000 chars is thinned and still draws.
- Denying the approval card runs nothing upstream and records denied in the audit log.
- The card never calls navigator.geolocation.
