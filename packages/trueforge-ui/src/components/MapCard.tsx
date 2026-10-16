'use client';

import type { FitBoundsOptions, Map as LeafletMap, TileLayer } from 'leaflet';
import { useEffect, useRef, useState } from 'react';

import type { MapsTransitStep, MapsTravelMode } from '@truefoundry/trueforge-core/core/permissions/mapsRouteSchemas';

import { describeDuration, describeTransitStep } from '../utils/mapsTransitSteps.js';

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
  /** Route card only; a card without a mode is a driving route. */
  mode?: MapsTravelMode;
  /** Transit route card only: local clock times and the steps in order. */
  departs?: string;
  arrives?: string;
  steps?: MapsTransitStep[];
  attribution: string;
}

const MODE_LABELS: Record<MapsTravelMode, string> = {
  walking: 'Walking',
  cycling: 'Cycling',
  driving: 'Driving',
  transit: 'Public transport',
};

export type MapCardState = 'ready' | 'blocked' | 'unavailable';

interface MapCardProps {
  data: MapCardData | null;
  state: MapCardState;
  blockedMessage?: string;
}

/** Tile errors with zero successful loads before the card gives up and shows the unavailable panel. */
const TILE_ERROR_THRESHOLD = 3;
/** Ms to wait for the first tile before declaring the map unloadable. */
const TILE_LOAD_TIMEOUT_MS = 10_000;
/** Keeps the end pins clear of the card edge and the zoom control; Leaflet takes pixel padding. */
const ROUTE_FIT_OPTIONS: FitBoundsOptions = { padding: [48, 48] };
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
 * A result the tool already settled (not found, no route, rate limited,
 * offline) or a route that cannot be drawn has nothing to retry, so its panel
 * has no Retry button.
 */
export function MapCard({ data, state, blockedMessage }: MapCardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The effect below keys on the stable setup key, so it reads the latest
  // data through a ref instead of closing over a fresh object each render.
  const dataRef = useRef(data);
  dataRef.current = data;
  // Set when the map cannot be shown; the card renders the unavailable panel for it.
  const [failure, setFailure] = useState<'tiles' | 'draw' | null>(null);
  // Bumped by Retry to re-create the tile layer exactly once per click.
  const [retryKey, setRetryKey] = useState(0);
  const setupKey = data === null ? null : mapSetupKey(data);

  useEffect(() => {
    if (setupKey === null || state !== 'ready' || failure !== null) {
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
    let resizeObserver: ResizeObserver | undefined;

    async function init() {
      if (cancelled || containerRef.current === null) {
        return;
      }
      try {
        await draw();
      } catch {
        // A bad polyline or a failed Leaflet load must show the panel, not a blank map.
        if (!cancelled) {
          setFailure('draw');
        }
      }
    }

    async function draw() {
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
      // Once the user takes the map over, a container resize no longer re-frames it.
      let userInteracted = false;
      const enableWheelZoom = () => {
        userInteracted = true;
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
          setFailure('tiles');
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

      // The card can change width after the map is built (layout settling, window or panel resize);
      // Leaflet only listens to window resizes, so re-measure and re-frame until the user takes over.
      let frame: () => void = () => undefined;
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
          map?.invalidateSize();
          if (!userInteracted) frame();
        });
        resizeObserver.observe(containerRef.current);
      }

      // Circle markers: no image assets to bundle or fail. Colors come from the theme through CSS classes.
      const pinStyle = { radius: 8, weight: 2, className: 'maps-card-pin' };
      if (mapData.kind === 'route' && mapData.route_geometry !== undefined) {
        const points = decodePolyline(mapData.route_geometry);
        const latlngs = points.map(([lat, lng]) => L.latLng(lat, lng));
        L.polyline(latlngs, { weight: 4, className: 'maps-card-route' }).addTo(map);
        const fromMarker = L.circleMarker(
          [mapData.from_lat ?? mapData.lat, mapData.from_lng ?? mapData.lng],
          pinStyle,
        ).addTo(map);
        const toMarker = L.circleMarker([mapData.to_lat ?? mapData.lat, mapData.to_lng ?? mapData.lng], pinStyle).addTo(
          map,
        );
        bindTextPopup(fromMarker, mapData.from_name ?? 'Origin');
        bindTextPopup(toMarker, mapData.to_name ?? 'Destination');
        const bounds = L.latLngBounds(latlngs);
        map.fitBounds(bounds, ROUTE_FIT_OPTIONS);
        frame = () => map?.fitBounds(bounds, ROUTE_FIT_OPTIONS);
      } else {
        map.setView([mapData.lat, mapData.lng], mapData.zoom);
        frame = () => map?.setView([mapData.lat, mapData.lng], mapData.zoom);
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
      resizeObserver?.disconnect();
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      map?.remove();
      map = null;
      tileLayer = null;
    };
  }, [setupKey, state, failure, retryKey]);

  const handleRetry = () => {
    // One-shot: re-create the tile layer once. If tiles fail again the
    // unavailable panel returns; the card never auto-retries.
    setFailure(null);
    setRetryKey(key => key + 1);
  };

  const showPanel = state === 'blocked' || state === 'unavailable' || data === null || failure !== null;
  const tilesFailed = failure === 'tiles';
  const panelTitle = tilesFailed ? 'Map tiles unavailable' : 'Map unavailable';
  const panelBody = tilesFailed
    ? 'The map tiles could not be loaded. Your place search was not sent again.'
    : failure === 'draw'
      ? 'The map could not be drawn.'
      : (blockedMessage ?? 'The map is not available right now.');

  // Every state shares the same .maps-card frame: identical width and radius.
  return (
    <div className="maps-card" data-testid="map-card">
      {showPanel ? (
        <div className="maps-card-blocked" role="status">
          <p className="maps-card-blocked-title">{panelTitle}</p>
          <p className="maps-card-blocked-body">{panelBody}</p>
          {tilesFailed && (
            <button type="button" className="maps-card-retry" onClick={handleRetry}>
              Retry
            </button>
          )}
        </div>
      ) : (
        <>
          <div ref={containerRef} className="maps-card-map" role="img" aria-label={mapSummary(data)} />
          <div className="maps-card-footer">
            <p className="maps-card-title">
              {data.kind === 'route' ? `${data.from_name ?? ''} → ${data.to_name ?? ''}` : data.resolved_name}
            </p>
            {mapSubtitle(data) !== null && <p className="maps-card-subtitle">{mapSubtitle(data)}</p>}
            {data.steps !== undefined && data.steps.length > 0 && (
              <ol className="maps-card-steps" aria-label="Steps">
                {data.steps.map((step, index) => (
                  <li key={`${String(index)}-${step.kind}`}>{describeTransitStep(step)}</li>
                ))}
              </ol>
            )}
            <p className="maps-card-attribution">
              <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
                {data.attribution}
              </a>
              <span aria-hidden="true"> · </span>
              {providerCredit(data)}
            </p>
          </div>
        </>
      )}
    </div>
  );
}

/** Who answered: the timetable service for public transport, the router for other routes, else the geocoder. */
function providerCredit(data: MapCardData): string {
  if (data.kind !== 'route') {
    return 'Search: Nominatim';
  }
  return data.mode === 'transit' ? 'Timetables: Transitous' : 'Routing: OSRM';
}

/** Mode, distance and time in one line, e.g. "Walking · 1.9 km · about 24 min". */
function routeSummary(data: MapCardData): string {
  const parts = [MODE_LABELS[data.mode ?? 'driving']];
  if (data.distance_km !== undefined) {
    parts.push(`${String(data.distance_km)} km`);
  }
  if (data.duration_min !== undefined) {
    parts.push(`about ${describeDuration(data.duration_min)}`);
  }
  if (data.departs !== undefined && data.arrives !== undefined) {
    parts.push(`leaves ${data.departs}, arrives ${data.arrives}`);
  }
  return parts.join(' · ');
}

/** Accessible summary for the map region. */
function mapSummary(data: MapCardData): string {
  if (data.kind === 'route') {
    return `${data.from_name ?? ''} to ${data.to_name ?? ''}, ${routeSummary(data)}`;
  }
  return data.address ?? data.resolved_name;
}

/**
 * Subtitle under the title. The address line is hidden when it duplicates the
 * resolved name, so the place name never appears twice.
 */
function mapSubtitle(data: MapCardData): string | null {
  if (data.kind === 'route') {
    return routeSummary(data);
  }
  if (data.address === null || data.address === data.resolved_name) {
    return null;
  }
  return data.address;
}
