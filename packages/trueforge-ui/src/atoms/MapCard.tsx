'use client';

import { useEffect, useRef } from 'react';

import 'leaflet/dist/leaflet.css';

import { cn } from './lib/cn.js';

export type MapPinView = {
  name: string;
  lat: number;
  lng: number;
};

export type MapRouteView = {
  /** Encoded polyline from the routing service, precision 5. */
  geometry: string;
  fromName: string;
  toName: string;
  distanceKm: number;
  durationMin: number;
};

export type MapCardProps = {
  resolvedName: string;
  address?: string;
  /** Place center. Absent for route cards, which center on the route. */
  lat?: number;
  lng?: number;
  zoom?: number;
  /** POI pins near the place. Never set together with route. */
  pins?: Array<MapPinView>;
  route?: MapRouteView;
  className?: string;
};

// OpenStreetMap standard tile layer. No API key required.
const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const DEFAULT_ZOOM = 13;
// Map height in rem (16rem = 256px). Follows the repo rule: rem for lengths.
const MAP_HEIGHT_REM = 16;
const ROUTE_LINE_COLOR = '#2563eb';

/**
 * Escapes HTML entities so a string can be safely passed to Leaflet's
 * bindPopup, which treats string arguments as HTML. Names reach here from
 * model output or crowdsourced geocoding data, so they must never be
 * interpreted as markup.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Decodes a precision-5 encoded polyline (the OSRM default) into
 * [lat, lng] pairs. Kept inline so the maps feature adds no new dependency.
 */
function decodePolyline(encoded: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let lat = 0;
  let lng = 0;
  let index = 0;
  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte = 0;
    do {
      byte = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) === 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) === 1 ? ~(result >> 1) : result >> 1;

    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

function midpointOf(points: Array<[number, number]>): [number, number] | undefined {
  const middle = points[Math.floor(points.length / 2)];
  return middle === undefined ? undefined : [middle[0], middle[1]];
}

/** Renders the route duration the way the caption line shows it. */
function formatRouteDuration(durationMin: number): string {
  const totalMinutes = Math.max(0, Math.round(durationMin));
  if (totalMinutes < 60) {
    return `about ${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `about ${hours}h` : `about ${hours}h ${minutes}m`;
}

/**
 * Renders an interactive Leaflet map card. Place cards show one pin for the
 * resolved place plus optional POI pins. Route cards draw the route polyline,
 * label both endpoints, and fit the map to the route bounds.
 * Leaflet is loaded dynamically so the map code never runs during SSR.
 */
export function MapCard({ resolvedName, address, lat, lng, zoom, pins, route, className }: MapCardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import('leaflet').Map | null>(null);
  const hasPlace = typeof lat === 'number' && typeof lng === 'number';

  useEffect(() => {
    const container = containerRef.current;
    if (container === null || mapRef.current !== null) {
      return;
    }
    let cancelled = false;
    // Dynamic import keeps Leaflet out of the server bundle and the initial
    // client chunk; the map initializes only when this card mounts.
    import('leaflet')
      .then(L => {
        if (cancelled) {
          return;
        }
        const routePoints = route === undefined ? [] : decodePolyline(route.geometry);
        const showRoute = route !== undefined && routePoints.length > 1;
        const center: [number, number] = midpointOf(routePoints) ?? (hasPlace ? [lat, lng] : [0, 0]);
        // Route cards fit to the route bounds below; the initial zoom only
        // matters for place cards.
        const map = L.map(container, {
          scrollWheelZoom: false,
        }).setView(center, zoom ?? DEFAULT_ZOOM);
        L.tileLayer(OSM_TILE_URL, {
          attribution: OSM_ATTRIBUTION,
          maxZoom: 19,
        }).addTo(map);
        if (showRoute && route !== undefined) {
          const line = L.polyline(routePoints, { color: ROUTE_LINE_COLOR }).addTo(map);
          const first = routePoints[0];
          const last = routePoints[routePoints.length - 1];
          if (first !== undefined) {
            L.marker(first).addTo(map).bindPopup(escapeHtml(route.fromName));
          }
          if (last !== undefined) {
            L.marker(last).addTo(map).bindPopup(escapeHtml(route.toName));
          }
          map.fitBounds(line.getBounds());
        } else if (hasPlace) {
          L.marker([lat, lng]).addTo(map).bindPopup(escapeHtml(resolvedName)).openPopup();
          for (const pin of pins ?? []) {
            L.marker([pin.lat, pin.lng]).addTo(map).bindPopup(escapeHtml(pin.name));
          }
        }
        mapRef.current = map;
      })
      .catch(() => {
        // If Leaflet fails to load, the caption block below still shows the
        // place name, address, or route summary.
      });
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [resolvedName, lat, lng, zoom, pins, route, hasPlace]);

  // Re-center if the pin coordinates change after mount.
  useEffect(() => {
    if (route === undefined && hasPlace) {
      mapRef.current?.setView([lat, lng], zoom ?? DEFAULT_ZOOM);
    }
  }, [route, hasPlace, lat, lng, zoom]);

  const caption = route === undefined ? undefined : `${Math.round(route.distanceKm)} km, ${formatRouteDuration(route.durationMin)}`;
  const ariaLabel =
    route === undefined
      ? `Map showing ${resolvedName}`
      : `Map showing route from ${route.fromName} to ${route.toName}`;

  return (
    <div data-slot="map-card" className={cn('w-full overflow-hidden rounded-lg border border-border', className)}>
      <div
        ref={containerRef}
        style={{ height: `${MAP_HEIGHT_REM}rem` }}
        className="w-full"
        aria-label={ariaLabel}
      />
      <div className="border-t border-border px-3 py-2">
        <p className="truncate text-sm font-medium">
          {route === undefined ? resolvedName : `${route.fromName} to ${route.toName}`}
        </p>
        <p className="text-xs text-muted-foreground">
          {route === undefined
            ? (address ?? (hasPlace ? `${lat.toFixed(4)}, ${lng.toFixed(4)}` : ''))
            : caption}
        </p>
      </div>
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    MapCard: typeof MapCard;
  }
}
