'use client';

import type { Map as LeafletMap, TileLayer } from 'leaflet';
import { useEffect, useRef, useState } from 'react';

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
 * Two coordinates closer than this (degrees) are the same spot on the map.
 * A POI result that coincides with the place itself draws one pin, not two.
 */
const SAME_SPOT_EPSILON = 1e-7;

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
 * Stable identity for the map setup, derived from the values that change what
 * the map shows. The parsed result object changes identity on every parent
 * render; keying the Leaflet setup on it tore the map down and rebuilt it
 * (re-requesting every tile) on each render.
 */
function mapSetupKey(data: MapCardData): string {
  const pins = data.pins.map(pin => `${pin.name}|${pin.lat.toFixed(6)}|${pin.lng.toFixed(6)}`).join(';');
  return [data.kind, data.lat.toFixed(6), data.lng.toFixed(6), String(data.zoom), pins, data.route_geometry ?? ''].join(
    '#',
  );
}

/**
 * Interactive map card. Tiles load only through the same-origin proxy; the
 * browser never contacts the tile host. Popups are DOM text nodes, never HTML.
 * No geolocation, no locate control.
 *
 * A blank map never ships: when tiles fail to load, the card shows the
 * "Map tiles unavailable" panel with a one-shot Retry instead of a grey box.
 */
export function MapCard({ data, state, blockedMessage, onRetry }: MapCardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The effect below keys on the stable setup key, so it reads the latest
  // data through a ref instead of closing over a fresh object each render.
  const dataRef = useRef(data);
  dataRef.current = data;
  // Set when tile loading fails; the card renders the unavailable panel.
  const [tilesFailed, setTilesFailed] = useState(false);
  // Bumped by Retry to re-create the tile layer exactly once per click.
  const [retryKey, setRetryKey] = useState(0);
  const setupKey = data === null ? null : mapSetupKey(data);

  useEffect(() => {
    if (setupKey === null || state !== 'ready' || tilesFailed) {
      return;
    }
    const el = containerRef.current;
    if (el === null) {
      return;
    }
    let cancelled = false;
    let map: LeafletMap | null = null;
    let tileLayer: TileLayer | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let observer: IntersectionObserver | undefined;

    async function init() {
      if (cancelled || containerRef.current === null) {
        return;
      }
      const current = dataRef.current;
      if (current === null) {
        return;
      }
      const L = await import('leaflet');
      if (cancelled || containerRef.current === null || dataRef.current === null) {
        return;
      }
      const mapData = dataRef.current;
      map = L.map(containerRef.current, {
        zoomControl: true,
        // Attribution renders in the card footer; the Leaflet control would duplicate it.
        attributionControl: false,
        // Wheel zoom stays off until the user focuses or clicks the map, so
        // scrolling the chat never gets trapped inside the map.
        scrollWheelZoom: false,
      });
      const enableWheelZoom = () => {
        map?.scrollWheelZoom.enable();
      };
      map.on('click', enableWheelZoom);
      map.on('focus', enableWheelZoom);

      tileLayer = L.tileLayer('/api/maps/tiles/{z}/{x}/{y}.png', {
        maxZoom: 18,
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
      if (mapData.kind === 'route' && mapData.route_geometry !== undefined) {
        const points = decodePolyline(mapData.route_geometry);
        const latlngs = points.map(([lat, lng]) => L.latLng(lat, lng));
        L.polyline(latlngs, { color: '#2563eb', weight: 4 }).addTo(map);
        const fromMarker = L.circleMarker(
          [mapData.from_lat ?? mapData.lat, mapData.from_lng ?? mapData.lng],
          pinStyle,
        ).addTo(map);
        const toMarker = L.circleMarker([mapData.to_lat ?? mapData.lat, mapData.to_lng ?? mapData.lng], pinStyle).addTo(
          map,
        );
        bindTextPopup(fromMarker, mapData.from_name ?? 'Origin');
        bindTextPopup(toMarker, mapData.to_name ?? 'Destination');
        map.fitBounds(L.latLngBounds(latlngs));
      } else {
        map.setView([mapData.lat, mapData.lng], mapData.zoom);
        const mainMarker = L.circleMarker([mapData.lat, mapData.lng], pinStyle).addTo(map);
        bindTextPopup(mainMarker, mapData.resolved_name);
        for (const pin of mapData.pins) {
          // A POI at the place itself would stack exactly on the main pin.
          if (
            Math.abs(pin.lat - mapData.lat) < SAME_SPOT_EPSILON &&
            Math.abs(pin.lng - mapData.lng) < SAME_SPOT_EPSILON
          ) {
            continue;
          }
          const marker = L.circleMarker([pin.lat, pin.lng], pinStyle).addTo(map);
          bindTextPopup(marker, pin.name);
        }
      }
    }

    // Build the map only once its container is visible: an off-screen card
    // must not burn tile requests or mis-measure its viewport.
    if (typeof IntersectionObserver === 'undefined') {
      void init();
    } else {
      observer = new IntersectionObserver(
        entries => {
          if (entries.some(entry => entry.isIntersecting)) {
            observer?.disconnect();
            observer = undefined;
            void init();
          }
        },
        { threshold: 0 },
      );
      observer.observe(el);
    }

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      map?.remove();
      map = null;
      tileLayer = null;
    };
  }, [setupKey, state, tilesFailed, retryKey]);

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
      ? (blockedMessage ?? 'The map tiles could not be loaded. Your place search was not sent again.')
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
            <p className="maps-card-attribution">
              <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
                {data.attribution}
              </a>
              <span aria-hidden="true"> · </span>
              {data.kind === 'route' ? 'Routing: OSRM' : 'Search: Nominatim'}
            </p>
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
