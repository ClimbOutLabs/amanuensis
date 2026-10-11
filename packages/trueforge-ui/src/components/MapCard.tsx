'use client';

import type { Map as LeafletMap, TileLayer } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';

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
  /**
   * Called when the user clicks Retry on a blocked or tile-failed panel.
   * When omitted, Retry re-attempts the tile layer once (one-shot, no auto-retry).
   */
  onRetry?: () => void;
}

/** Tile errors with zero successful loads before the card gives up and shows the unavailable panel. */
const TILE_ERROR_THRESHOLD = 3;
/** Ms to wait for the first tile before declaring the map unloadable. */
const TILE_LOAD_TIMEOUT_MS = 10_000;

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

function bindTextPopup(marker: { bindPopup: (el: HTMLElement) => unknown }, text: string) {
  // Popup content as a DOM text node: never an HTML string.
  const el = document.createElement('div');
  el.appendChild(document.createTextNode(text));
  marker.bindPopup(el);
}

/**
 * Interactive map card. Tiles load only through the same-origin proxy; the
 * browser never contacts the tile host. Popups are DOM text nodes, never HTML.
 * No geolocation, no locate control.
 *
 * A blank map never ships: when tiles fail to load, the card shows the
 * "Map tiles unavailable" panel with a one-shot Retry instead of a grey box.
 */
export function MapCard({ data, state, cardId, blockedMessage, onRetry }: MapCardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const { mode } = useTheme();
  // Set when tile loading fails; the card renders the unavailable panel.
  const [tilesFailed, setTilesFailed] = useState(false);
  // Bumped by Retry to re-create the tile layer exactly once per click.
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let map: LeafletMap | null = null;
    let tileLayer: TileLayer | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    async function init() {
      if (containerRef.current === null || data === null || state !== 'ready' || tilesFailed) {
        return;
      }
      const L = await import('leaflet');
      if (cancelled || containerRef.current === null) {
        return;
      }
      map = L.map(containerRef.current, {
        zoomControl: true,
        // Attribution renders in the card footer; the Leaflet control would duplicate it.
        attributionControl: false,
      });
      mapRef.current = map;

      const tileUrl = `/api/maps/tiles/{z}/{x}/{y}.png?card=${encodeURIComponent(cardId)}`;
      tileLayer = L.tileLayer(tileUrl, {
        maxZoom: 18,
        ...(mode === 'dark' ? { className: 'maps-tiles-dark' } : {}),
      });

      // A grey box is not an acceptable failure mode: when tiles cannot load,
      // show the unavailable panel with a Retry instead.
      let loaded = 0;
      let errored = 0;
      const fail = () => {
        if (!cancelled && loaded === 0) {
          setTilesFailed(true);
        }
      };
      tileLayer.on('tileload', () => {
        loaded += 1;
      });
      tileLayer.on('tileerror', () => {
        errored += 1;
        if (errored >= TILE_ERROR_THRESHOLD) {
          fail();
        }
      });
      timeout = setTimeout(fail, TILE_LOAD_TIMEOUT_MS);
      tileLayer.addTo(map);

      // Circle markers: no image assets to bundle or fail.
      const pinStyle = { radius: 8, color: '#ffffff', weight: 2, fillColor: '#dc2626', fillOpacity: 1 };
      if (data.kind === 'route' && data.route_geometry !== undefined) {
        const points = decodePolyline(data.route_geometry);
        const latlngs = points.map(([lat, lng]) => L.latLng(lat, lng));
        L.polyline(latlngs, { color: '#2563eb', weight: 4 }).addTo(map);
        const fromMarker = L.circleMarker([data.from_lat ?? data.lat, data.from_lng ?? data.lng], pinStyle).addTo(map);
        const toMarker = L.circleMarker([data.to_lat ?? data.lat, data.to_lng ?? data.lng], pinStyle).addTo(map);
        bindTextPopup(fromMarker, data.from_name ?? 'Origin');
        bindTextPopup(toMarker, data.to_name ?? 'Destination');
        map.fitBounds(L.latLngBounds(latlngs));
      } else {
        map.setView([data.lat, data.lng], data.zoom);
        const mainMarker = L.circleMarker([data.lat, data.lng], pinStyle).addTo(map);
        bindTextPopup(mainMarker, data.resolved_name);
        for (const pin of data.pins) {
          const marker = L.circleMarker([pin.lat, pin.lng], pinStyle).addTo(map);
          bindTextPopup(marker, pin.name);
        }
      }
    }

    void init();
    return () => {
      cancelled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      map?.remove();
      mapRef.current = null;
      tileLayer = null;
    };
  }, [data, state, cardId, mode, tilesFailed, retryKey]);

  const handleRetry = () => {
    if (onRetry !== undefined) {
      onRetry();
      return;
    }
    // One-shot: re-create the tile layer once. If tiles fail again the
    // unavailable panel returns; the card never auto-retries.
    setTilesFailed(false);
    setRetryKey(key => key + 1);
  };

  const showPanel = state === 'blocked' || state === 'unavailable' || data === null || tilesFailed;
  const panelTitle = state === 'blocked' && !tilesFailed ? 'Map unavailable' : 'Map tiles unavailable';
  const panelBody =
    tilesFailed || state === 'unavailable'
      ? (blockedMessage ?? 'The map tiles could not be loaded.')
      : (blockedMessage ??
        'This map is blocked right now. Tiles are unavailable while offline or over the rate limit.');

  // Every state shares the same .maps-card frame: identical width and radius.
  return (
    <div className="maps-card" data-testid="map-card">
      {showPanel ? (
        <div className="maps-card-blocked" role="status">
          <p className="maps-card-blocked-title">{panelTitle}</p>
          <p className="maps-card-blocked-body">{panelBody}</p>
          <button type="button" className="maps-card-retry" onClick={handleRetry}>
            Retry
          </button>
        </div>
      ) : (
        <>
          <div ref={containerRef} className="maps-card-map" role="img" aria-label={mapSummary(data)} />
          <div className="maps-card-footer">
            <p className="maps-card-title">
              {data.kind === 'route' ? `${data.from_name ?? ''} → ${data.to_name ?? ''}` : data.resolved_name}
            </p>
            {mapSubtitle(data) !== null && <p className="maps-card-subtitle">{mapSubtitle(data)}</p>}
            <p className="maps-card-attribution">{data.attribution}</p>
          </div>
        </>
      )}
    </div>
  );
}

/** Accessible summary for the map region. */
function mapSummary(data: MapCardData): string {
  if (data.kind === 'route') {
    return (
      `${data.from_name ?? ''} to ${data.to_name ?? ''}` +
      (data.distance_km !== undefined ? `, ${String(data.distance_km)} km` : '') +
      (data.duration_min !== undefined ? `, about ${String(data.duration_min)} min` : '')
    );
  }
  return data.address ?? data.resolved_name;
}

/**
 * Subtitle under the title. The address line is hidden when it duplicates the
 * resolved name, so the place name never appears twice.
 */
function mapSubtitle(data: MapCardData): string | null {
  if (data.kind === 'route') {
    return mapSummary(data);
  }
  if (data.address === null || data.address === data.resolved_name) {
    return null;
  }
  return data.address;
}
