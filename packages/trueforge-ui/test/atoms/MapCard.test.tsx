import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MapCard } from '@/atoms/MapCard.js';
import { parseMapCardProps } from '@/utils/toolCallParsing.js';
import { RENDER_MAP_TOOL_NAME, RENDER_ROUTE_TOOL_NAME } from '@truefoundry/trueforge-core/core';

type LeafletCallLog = {
  mapCenters: Array<[number, number]>;
  mapZooms: Array<number>;
  markers: Array<[number, number]>;
  popups: Array<string>;
  polylines: Array<Array<[number, number]>>;
  fitBoundsCalls: number;
  reset(): void;
};

const leafletCalls = vi.hoisted((): LeafletCallLog => {
  const state: LeafletCallLog = {
    mapCenters: [],
    mapZooms: [],
    markers: [],
    popups: [],
    polylines: [],
    fitBoundsCalls: 0,
    reset() {
      state.mapCenters = [];
      state.mapZooms = [];
      state.markers = [];
      state.popups = [];
      state.polylines = [];
      state.fitBoundsCalls = 0;
    },
  };
  return state;
});

vi.mock('leaflet', () => {
  const calls = leafletCalls;
  type LatLng = [number, number];
  const createMap = () => {
    const api = {
      setView: (center: LatLng, zoom: number) => {
        calls.mapCenters.push(center);
        calls.mapZooms.push(zoom);
        return api;
      },
      fitBounds: () => {
        calls.fitBoundsCalls += 1;
        return api;
      },
      remove: () => undefined,
    };
    return api;
  };
  const createMarker = (latlng: LatLng) => {
    calls.markers.push(latlng);
    const api = {
      addTo: () => api,
      bindPopup: (html: string) => {
        calls.popups.push(html);
        return api;
      },
      openPopup: () => api,
    };
    return api;
  };
  const createPolyline = (latlngs: Array<LatLng>) => {
    calls.polylines.push(latlngs);
    const api = {
      addTo: () => api,
      getBounds: () => ({ latlngs }),
    };
    return api;
  };
  return {
    map: () => createMap(),
    tileLayer: () => ({ addTo: () => undefined }),
    marker: (latlng: LatLng) => createMarker(latlng),
    polyline: (latlngs: Array<LatLng>) => createPolyline(latlngs),
  };
});

describe('MapCard', () => {
  beforeEach(() => {
    leafletCalls.reset();
  });

  it('renders a place card with the resolved name and address', async () => {
    const { container } = render(
      <MapCard resolvedName="Paris, France" address="Paris, Ile-de-France, France" lat={48.8566} lng={2.3522} />,
    );

    expect(screen.getByText('Paris, France')).toBeInTheDocument();
    expect(screen.getByText('Paris, Ile-de-France, France')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="map-card"]')).toBeInTheDocument();

    await waitFor(() => expect(leafletCalls.markers).toHaveLength(1));
    expect(leafletCalls.markers[0]).toEqual([48.8566, 2.3522]);
    expect(leafletCalls.popups[0]).toBe('Paris, France');
    expect(leafletCalls.polylines).toHaveLength(0);
  });

  it('renders one marker per POI pin', async () => {
    render(
      <MapCard
        resolvedName="Paris, France"
        lat={48.8566}
        lng={2.3522}
        pins={[
          { name: 'Cafe A', lat: 48.86, lng: 2.35 },
          { name: 'Cafe B', lat: 48.85, lng: 2.34 },
        ]}
      />,
    );

    await waitFor(() => expect(leafletCalls.markers).toHaveLength(3));
    expect(leafletCalls.markers[1]).toEqual([48.86, 2.35]);
    expect(leafletCalls.markers[2]).toEqual([48.85, 2.34]);
    expect(leafletCalls.popups).toContain('Cafe A');
    expect(leafletCalls.popups).toContain('Cafe B');
  });

  it('renders a route polyline with labeled endpoints and a distance/duration caption', async () => {
    render(
      <MapCard
        resolvedName="Madrid to Barcelona"
        route={{
          geometry: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
          fromName: 'Madrid, Spain',
          toName: 'Barcelona, Spain',
          distanceKm: 621,
          durationMin: 370,
        }}
      />,
    );

    expect(screen.getByText('Madrid, Spain to Barcelona, Spain')).toBeInTheDocument();
    expect(screen.getByText('621 km, about 6h 10m')).toBeInTheDocument();

    await waitFor(() => expect(leafletCalls.polylines).toHaveLength(1));
    const line = leafletCalls.polylines[0] ?? [];
    expect(line).toHaveLength(3);
    expect(line[0]?.[0]).toBeCloseTo(38.5, 4);
    expect(line[0]?.[1]).toBeCloseTo(-120.2, 4);
    expect(leafletCalls.markers).toHaveLength(2);
    expect(leafletCalls.popups).toContain('Madrid, Spain');
    expect(leafletCalls.popups).toContain('Barcelona, Spain');
    expect(leafletCalls.fitBoundsCalls).toBe(1);
  });

  it('renders a malicious popup label as inert text', async () => {
    const label = '<img src=x onerror=alert(1)>';
    render(<MapCard resolvedName={label} lat={0} lng={0} />);

    // React escapes the caption text, so the label stays inert in the DOM.
    expect(screen.getByText(label)).toBeInTheDocument();

    await waitFor(() => expect(leafletCalls.popups).toHaveLength(1));
    expect(leafletCalls.popups[0]).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('parseMapCardProps', () => {
  it('parses a render_map result into MapCard props', () => {
    const props = parseMapCardProps(
      RENDER_MAP_TOOL_NAME,
      JSON.stringify({
        map_card_id: 'abc',
        resolved_name: 'Paris, France',
        address: 'Paris, Ile-de-France, France',
        lat: 48.8566,
        lng: 2.3522,
        zoom: 10,
        pins: [{ name: 'Cafe A', lat: 48.86, lng: 2.35 }],
      }),
    );
    expect(props).toEqual({
      resolvedName: 'Paris, France',
      address: 'Paris, Ile-de-France, France',
      lat: 48.8566,
      lng: 2.3522,
      zoom: 10,
      pins: [{ name: 'Cafe A', lat: 48.86, lng: 2.35 }],
    });
  });

  it('clamps a forged out-of-range zoom value', () => {
    const tooFar = parseMapCardProps(
      RENDER_MAP_TOOL_NAME,
      JSON.stringify({ resolved_name: 'Paris, France', lat: 48.8566, lng: 2.3522, zoom: 999 }),
    );
    expect(tooFar?.zoom).toBe(18);
    const tooClose = parseMapCardProps(
      RENDER_MAP_TOOL_NAME,
      JSON.stringify({ resolved_name: 'Paris, France', lat: 48.8566, lng: 2.3522, zoom: -3 }),
    );
    expect(tooClose?.zoom).toBe(1);
  });

  it('parses a render_route result into MapCard props', () => {
    const props = parseMapCardProps(
      RENDER_ROUTE_TOOL_NAME,
      JSON.stringify({
        map_card_id: 'abc',
        from_resolved: 'Madrid, Spain',
        to_resolved: 'Barcelona, Spain',
        distance_km: 621,
        duration_min: 370,
        route_geometry: '_p~iF~ps|U',
      }),
    );
    expect(props?.resolvedName).toBe('Madrid, Spain to Barcelona, Spain');
    expect(props?.lat).toBeUndefined();
    expect(props?.route).toEqual({
      geometry: '_p~iF~ps|U',
      fromName: 'Madrid, Spain',
      toName: 'Barcelona, Spain',
      distanceKm: 621,
      durationMin: 370,
    });
  });

  it('unwraps the tool.response.v2 envelope', () => {
    const envelope = JSON.stringify({
      schema_version: 'tool.response.v2',
      outcome: { disposition: 'executed_ok' },
      result: { map_card_id: 'abc', resolved_name: 'Paris, France', lat: 48.85, lng: 2.35 },
    });
    expect(parseMapCardProps(RENDER_MAP_TOOL_NAME, envelope)?.resolvedName).toBe('Paris, France');
  });

  it('returns undefined for error, malformed, or mismatched results', () => {
    expect(parseMapCardProps(RENDER_MAP_TOOL_NAME, JSON.stringify({ error: 'not_found' }))).toBeUndefined();
    expect(parseMapCardProps(RENDER_ROUTE_TOOL_NAME, JSON.stringify({ error: 'no_route' }))).toBeUndefined();
    expect(parseMapCardProps(RENDER_MAP_TOOL_NAME, JSON.stringify({ resolved_name: 'Paris' }))).toBeUndefined();
    expect(
      parseMapCardProps(RENDER_ROUTE_TOOL_NAME, JSON.stringify({ from_resolved: 'Madrid, Spain' })),
    ).toBeUndefined();
    expect(parseMapCardProps(RENDER_MAP_TOOL_NAME, 'not json at all')).toBeUndefined();
    expect(parseMapCardProps(RENDER_MAP_TOOL_NAME, undefined)).toBeUndefined();
    expect(
      parseMapCardProps('exec', JSON.stringify({ resolved_name: 'Paris, France', lat: 1, lng: 2 })),
    ).toBeUndefined();
  });
});
