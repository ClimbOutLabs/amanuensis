# Spec: Embedded Maps

## Problem

Location-related queries return text-only responses. Users cannot see spatial context (where a place is, what is around it) without doing the mental mapping themselves.

## Solution

Add a model-callable `render_map` tool. When the user asks about a place and a map would help, the model calls the tool and an interactive map card appears inline in the conversation.

Model-callable tool only. No Map button in the UI. No automatic detection of the user's own location.

## Tool contract

```typescript
render_map(params: {
  place_name: string;      // "Paris", "Eiffel Tower", "1600 Amphitheatre Parkway"
  poi?: string;            // "coffee shop", "pharmacy" - optional POI search near the place
  zoom?: number;           // 1-18, default 13
}) -> {
  map_card_id: string;
  resolved_name: string;   // top Nominatim match, e.g. "Paris, France"
  address?: string;        // from Nominatim display/address data; shown on the card
  lat: number;
  lng: number;
  pins?: Array<{           // POI results when poi is given, max 5
    name: string;
    lat: number;
    lng: number;
  }>;
}
```

```typescript
render_route(params: {
  from_place: string;      // "Madrid"
  to_place: string;        // "Barcelona"
}) -> {
  map_card_id: string;
  from_resolved: string;   // top Nominatim match for origin
  to_resolved: string;     // top Nominatim match for destination
  distance_km: number;
  duration_min: number;
  route_geometry: string;  // encoded polyline, OSRM default precision 5
}
```

The model passes place names. The tools geocode (Nominatim), not the model. The model never passes raw coordinates.

When `poi` is given, the tool searches Nominatim for that POI type near the geocoded place (e.g. "coffee shop in Paris") and returns up to 5 pins. The area always comes from the named place, never from the user's location.

`render_route` geocodes both places, then calls OSRM (OSM-based routing, no API key) for the route. Both endpoints must be named by the user. There is no "from my current location" mode.

Tool description given to the model:

> "Render an interactive map with a pin for a named place. Pass the place name as the user gave it (e.g. 'Paris', 'Eiffel Tower'). The tool geocodes the name and returns an inline map card. Use when the user explicitly asks to see a place on a map or asks where a place is."

> "Render a route map between two named places. Pass both place names as the user gave them (e.g. from_place 'Madrid', to_place 'Barcelona'). The tool geocodes both endpoints, routes via OSRM, and returns an inline map card with the route polyline, distance, and duration. Use when the user asks for directions between two named places. Both endpoints must be named by the user; there is no current-location mode."

Errors: if geocoding returns no match, the tool returns `{ error: "not_found" }` and the model responds with text explaining it could not find the place. If the geocode service is unreachable, the tool returns `{ error: "service_unavailable" }` and the model says so in plain text. No map card renders in either case.

POI zero-match: if the place geocodes but the POI search returns no matches, the tool returns the place map with `pins: []`. The model says it found the place but found no matching POIs nearby (e.g. "I found Hospital Clinic, but no parking nearby"). This is not an error; the card renders with the place pin.

`render_route` errors:

- `{ error: "not_found", field: "from_place" }` or `{ error: "not_found", field: "to_place" }`: names which endpoint failed to geocode, so the model can say which one it could not find.
- `{ error: "no_route" }`: both endpoints geocoded, but OSRM found no road connection (e.g. islands). The model explains in plain text that it cannot route between them.
- `{ error: "service_unavailable" }`: Nominatim or OSRM unreachable. The model says so in plain text.

No map card renders for any `render_route` error.

## Call rules for the model

Call `render_map` when:

- The user asks to see a place: "show me X", "show me X on a map", "where is X", "map of X". "Show me Paris" works; the model does not require the words "on a map".
- The user asks for POIs near a named place: "coffee shops in Paris", "pharmacies near the Eiffel Tower". The area comes from the named place, never from the user's location.

Call `render_route` when:

- The user asks for directions between two named places: "directions from Madrid to Barcelona", "how do I get from X to Y", "route from X to Y". Both endpoints must be named.

Do NOT call when:

- A location is mentioned in passing ("my Paris trip was great"). No map appears uninvited.
- "Show me X" where X is clearly not a place ("show me the quarterly report", "show me your code"). The model uses judgment; the tool is for places.
- The user asks for "nearest X" without naming a place ("nearest coffee shop"). The model asks which area to search, since it does not track the user's location.
- The user asks for directions without a starting point ("directions to Barcelona", "how do I get there"). The model asks where from, since it does not track the user's location.
- The user uses a user-centric shorthand as the origin ("directions from home", "from my place"). The model treats these as unnamed locations and asks for a named starting point. It never resolves "home" to a memorized address and never transmits the user's actual location.

## Key journeys

**Doctor's appointment.** The user has a doctor's appointment in their calendar with a location. They ask: "How do I get to my doctor's appointment tomorrow?"

1. The model looks up the calendar and finds the appointment and its location ("Hospital Clinic, Barcelona, 2pm").
2. The model does not track the user's location, so it asks: "Where are you coming from?"
3. User: "From Placa de Catalunya." The model calls `render_route(from_place="Placa de Catalunya", to_place="Hospital Clinic, Barcelona")`.
4. A MapCard renders with the route polyline, distance, and duration.

The maps spec does not depend on the calendar implementation. The calendar provides a location string; the model passes it to `render_route` like any other named place. "Leave in time for your appointment" (smart departure) stays out of scope.

**POI near an appointment.** "Find parking near Hospital Clinic" → the model uses the appointment location from the calendar as the named place and calls `render_map(place_name="Hospital Clinic, Barcelona", poi="parking")`.

## Ambiguity

Nominatim returns ranked matches. v1 uses the top result. The MapCard shows the resolved place name prominently (e.g. "Paris, France"), so the user can spot a wrong pick at a glance. No disambiguation UI in v1.

## Multi-location queries

"Show me Paris and London on a map" renders one MapCard per resolved location, in query order, max 3. Beyond 3 locations, the model asks the user to pick.

## UI component

- `MapCard` in the generative UI system: interactive Leaflet map, one pin, zoom controls.
- Shows the resolved place name and address (from the `address` payload field).
- Mobile-responsive: the card fills the message width; on small screens it renders inline with pinch zoom.
- Popup labels are escaped (untrusted data).
- Loading state while geocoding; plain-text fallback on failure. The tool-to-UI contract: the tool returns the payload above, the renderer draws the card, failure returns an error the model turns into text.
- Route rendering: when the payload comes from `render_route`, the card draws `route_geometry` as a polyline, marks and labels both endpoints (`from_resolved`, `to_resolved`), fits the map to the route bounds, and shows a caption line under the map with distance and duration (e.g. "621 km, about 6h 10m"). POI pins and route polylines never appear on the same card.

## Provider and geocoding

- Map tiles: OpenStreetMap via Leaflet. No API key. No tracking.
- Geocoding: Nominatim. Respect the Nominatim usage policy (1 req/s, identifying User-Agent, cache results).
- Routing: OSRM (OSM-based, no API key). Same usage discipline as Nominatim.
- All tile, geocode, and routing requests go to OSM services over HTTPS. No location data goes anywhere else.

## Offline mode

`render_map` and `render_route` declare `requires_network: true` in their tool manifests: they need Nominatim (geocoding), OSM (tiles), and OSRM (routing), all over the internet.

When offline mode is on, the tools are not offered to the model. They are not invoked. If the user asks for a map or directions while offline, the model explains plainly that they need a network connection. No cached-tile fallback in v1.

## Privacy

No user location is ever collected, stored, or transmitted. Data sent externally: place and endpoint names to Nominatim for geocoding (including calendar-derived locations, e.g. an appointment venue), route endpoints to OSRM for routing, and tile requests to OSM. Document this data flow in the privacy dashboard.

## Scope

- Model-callable `render_map` and `render_route` tools (v1).
- One MapCard per location, max 3 per query.
- POI search around a named place ("coffee shops in Paris"), up to 5 pins. The area always comes from the named place, never from the user's location.
- Routing between two named places ("directions from Madrid to Barcelona"). Route polyline rendered on the map, with distance and duration. Both endpoints named by the user.
- No Map button. No automatic location detection. No tracking.

## Out of scope

- Real-time location tracking.
- "Nearest X" or "directions to X" without a named starting point (requires user location, which is not collected).
- Turn-by-turn navigation UI.
- Smart departure times: cut from this spec. If built later, it gets its own spec.

## Testing

- Synthetic place names only (no real user location data).
- "Show me Paris on a map" renders a MapCard pinned in France with "Paris, France" labeled.
- Unknown place name ("show me Xyzqpl on a map") degrades to a plain-text explanation.
- Malicious popup label input renders as inert text, not markup.
- "Coffee shops in Paris" renders a MapCard with up to 5 POI pins near Paris.
- "Nearest coffee shop" (no place named) gets a plain-text ask for which area to search, not a map.
- "Directions from Madrid to Barcelona" renders a MapCard with the route polyline, distance, and duration.
- "Directions from Xyzqpl to Barcelona" degrades to a plain-text explanation naming Xyzqpl as the place it could not find.
- Routing service failure ("service_unavailable") degrades to a plain-text explanation.
- No road connection between two geocoded places ("no_route") gets a plain-text explanation that it cannot route between them.
- "How do I get to Barcelona" (no starting point) gets a plain-text ask for where from, not a map.
- "Find parking near Xyzqpl" (unknown place) degrades to plain text; "find parking near Paris" with zero matches renders the Paris card with no pins and a plain-text note that no parking was found nearby.
- Offline mode: both tools absent from the model. "Show me Paris" and "directions from Madrid to Barcelona" each get a plain-text explanation that maps need a network connection.
