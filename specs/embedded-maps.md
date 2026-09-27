# Spec: Embedded Maps with Location Pins

## Problem
When Sidd asks Aman something location-related ("where's the nearest...", "show me Madrid on a map", "how do I get to..."), Aman responds with text only. A personal AI assistant should render a visual map with a pin.

## Solution
Add map rendering to Aman's generative UI. When the agent detects a location query, it geocodes the location and renders an interactive map with a pin.

## Design Decisions

**Maps provider:** OpenStreetMap via Leaflet
- No API key required (critical for local-first, no secrets to manage)
- Privacy-friendly (no Google tracking)
- Works with the "private by architecture" positioning
- Tiles can be cached for offline use later

**Geocoding:** Nominatim (OSM's geocoder)
- Free, no API key
- Good enough for city/place/address queries
- Fallback: if geocoding fails, show a text response explaining why

**Trigger:** Agent detects location intent
- Explicit: "show me X on a map", "where is X"
- Implicit: "nearest coffee shop", "directions to..."
- The agent calls a `render_map` tool with lat/lng or a place name

## UI Component
- New `MapCard` component in the generative UI system
- Interactive Leaflet map with a pin at the location
- Shows place name, address (from reverse geocoding)
- Zoom controls, no tracking

## Scope
- Single pin per query (v1)
- No routing/directions (future)
- No multiple pins (future)
- Mobile-responsive (Sidd uses mobile browser)

## Privacy
- No location data sent to third parties beyond the tile/geocode request
- Document this in the privacy dashboard (ties into feature #5: private by architecture)

## Testing
- Synthetic locations (not Sidd's real location)
- Verify: "show me Madrid on a map" renders correctly
- Verify: geocoding failure degrades gracefully to text

## Out of Scope
- Real-time location tracking
- Directions/routing
- Business search ("nearest coffee shop" needs a POI API, separate feature)

---

## Phase 2: Smart Departure Times

**Scenario:** Sidd has a calendar appointment with a location. Aman tells him when to leave.

**How it works:**
1. Calendar MCP provides upcoming events with locations
2. Aman geocodes the event location
3. Calculates travel time from current location (or a configured "home base")
4. Proactive notification: "Leave in 15 minutes to make your 2pm at [place]"
5. Renders a map showing the route origin/destination

**Requires:**
- Calendar MCP integrations (Google, Outlook, iCal) - see separate spec
- Travel time estimation (OSRM for OSM-based routing, no API key)
- Proactive notification system (ties into feature #2: scheduled tasks)

**Privacy:** Location never leaves the device except for tile/geocode/routing requests to OSM services. No Google Maps API.
