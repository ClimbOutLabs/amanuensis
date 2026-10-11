'use client';

import { useEffect, useRef } from 'react';
import type { Map as LeafletMap } from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { useTheme } from '../theme/ThemeProvider.js';

export interface MapPin {
  name: string;
  lat: number;
  lng: number;
}

export interface MapCardData {
  kind: 'place' | 'route';
  /** Place card: center and pins. Route card: endpoints and geometry. */
  lat: number;
  lng: number;
  zoom: number;
  resolved_name: string;
  address: string | null;
  pins: MapPin[];
  /** Route card only. */
  from_name?: string;
  to_name?: string;
  from_lat?: number;
  from_lng?: number;
  to_lat?: number;
  to_lng?: number;
  distance_km?: number;
  duration_min?: number;
  route_geometry?: string;
  attribution: string;
}

export type MapCardState = 'ready' | 'blocked' | 'unavailable';

interface MapCardProps {
  data: MapCardData | null;
  state: MapCardState;
  /** Tool call id: keys the proxy rate limit per card. */
  cardId: string;
  blockedMessage?: string;
}

/**
 * Decode a precision-5 encoded polyline to [lat, lng] pairs.
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

/**
 * Interactive map card. Tiles load only through the same-origin proxy; the
 * browser never contacts the tile host. Popups are DOM text nodes, never HTML.
 * No geolocation, no locate control.
 */
export function MapCard({ data, state, cardId, blockedMessage }: MapCardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const { mode } = useTheme();

  useEffect(() => {
    let cancelled = false;
    let map: LeafletMap | null = null;

    async function init() {
      if (containerRef.current === null || data === null || state !== 'ready') {
        return;
      }
      const L = await import('leaflet');
      if (cancelled || containerRef.current === null) {
        return;
      }
      // Leaflet CSS is bundled by the host app; the map div needs explicit size.
      map = L.map(containerRef.current, {
        zoomControl: true,
        attributionControl: true,
      });
      mapRef.current = map;

      const tileUrl = `/api/maps/tiles/{z}/{x}/{y}.png?card=${encodeURIComponent(cardId)}`;
      L.tileLayer(tileUrl, {
        maxZoom: 18,
        attribution: data.attribution,
        ...(mode === 'dark' ? { className: 'maps-tiles-dark' } : {}),
      }).addTo(map);

      if (data.kind === 'route' && data.route_geometry !== undefined) {
        const points = decodePolyline(data.route_geometry);
        const latlngs = points.map(([lat, lng]) => L.latLng(lat, lng));
        L.polyline(latlngs, { color: '#2563eb', weight: 4 }).addTo(map);
        const fromMarker = L.marker([data.from_lat ?? data.lat, data.from_lng ?? data.lng]).addTo(map);
        const toMarker = L.marker([data.to_lat ?? data.lat, data.to_lng ?? data.lng]).addTo(map);
        bindTextPopup(fromMarker, data.from_name ?? 'Origin');
        bindTextPopup(toMarker, data.to_name ?? 'Destination');
        map.fitBounds(L.latLngBounds(latlngs));
      } else {
        map.setView([data.lat, data.lng], data.zoom);
        const mainMarker = L.marker([data.lat, data.lng]).addTo(map);
        bindTextPopup(mainMarker, data.resolved_name);
        for (const pin of data.pins) {
          const marker = L.marker([pin.lat, pin.lng]).addTo(map);
          bindTextPopup(marker, pin.name);
        }
      }
    }

    function bindTextPopup(marker: { bindPopup: (el: HTMLElement) => void }, text: string) {
      // Popup content as a DOM text node: never an HTML string.
      const el = document.createElement('div');
      el.appendChild(document.createTextNode(text));
      marker.bindPopup(el);
    }

    void init();
    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
  }, [data, state, cardId, mode]);

  const cardData = data;
  if (state === 'blocked' || state === 'unavailable' || cardData === null) {
    return (
      <div className="maps-card maps-card-blocked" role="status">
        <p className="maps-card-blocked-title">
          {state === 'blocked' ? 'Map unavailable' : 'Map could not load'}
        </p>
        <p className="maps-card-blocked-body">
          {blockedMessage ??
            (state === 'blocked'
              ? 'This map is blocked right now. Tiles are unavailable while offline or over the rate limit.'
              : 'The map data could not be loaded.')}
        </p>
      </div>
    );
  }

  const summary =
    cardData.kind === 'route'
      ? `${cardData.from_name ?? ''} to ${cardData.to_name ?? ''}` +
        (cardData.distance_km !== undefined ? `, ${cardData.distance_km} km` : '') +
        (cardData.duration_min !== undefined ? `, about ${cardData.duration_min} min` : '')
      : (cardData.address ?? cardData.resolved_name);

  return (
    <div className="maps-card" data-testid="map-card">
      <div ref={containerRef} className="maps-card-map" role="img" aria-label={summary} />
      <div className="maps-card-footer">
        <p className="maps-card-title">{cardData.kind === 'route' ? `${cardData.from_name ?? ''} → ${cardData.to_name ?? ''}` : cardData.resolved_name}</p>
        <p className="maps-card-subtitle">{summary}</p>
        <p className="maps-card-attribution">{cardData.attribution}</p>
      </div>
    </div>
  );
}
