import { describe, expect, it } from 'vitest';

import { parseMapsResult } from '@/utils/toolCallParsing.js';

describe('parseMapsResult', () => {
  it('parses a render_map ok result', () => {
    const parsed = parseMapsResult(
      JSON.stringify({
        status: 'ok',
        resolved_name: 'Paris, France',
        address: 'Paris, France',
        lat: 48.85,
        lng: 2.35,
        zoom: 13,
        pins: [{ name: 'Cafe', lat: 48.86, lng: 2.36 }],
        attribution: '© OpenStreetMap contributors',
      }),
      'render_map',
    );
    expect(parsed.state).toBe('ready');
    expect(parsed.data?.kind).toBe('place');
    expect(parsed.data?.resolved_name).toBe('Paris, France');
    expect(parsed.data?.pins).toHaveLength(1);
  });

  it('unwraps the tool.response.v2 envelope the host sends on the wire', () => {
    const result = {
      status: 'ok',
      resolved_name: 'Paris, France',
      address: null,
      lat: 48.85,
      lng: 2.35,
      zoom: 13,
      pins: [],
      attribution: '© OpenStreetMap contributors',
    };
    const wrap = (inner: unknown) =>
      JSON.stringify({ schema_version: 'tool.response.v2', outcome: { disposition: 'executed_ok' }, result: inner });
    for (const inner of [result, JSON.stringify(result)]) {
      const parsed = parseMapsResult(wrap(inner), 'render_map');
      expect(parsed.state).toBe('ready');
      expect(parsed.data?.resolved_name).toBe('Paris, France');
    }
    const blocked = parseMapsResult(wrap({ status: 'error', code: 'rate_limited', service: 'geocoder' }), 'render_map');
    expect(blocked.state).toBe('blocked');
  });

  it('parses a render_route ok result', () => {
    const parsed = parseMapsResult(
      JSON.stringify({
        status: 'ok',
        from: { resolved_name: 'Madrid', lat: 40.41, lng: -3.7 },
        to: { resolved_name: 'Barcelona', lat: 41.38, lng: 2.17 },
        distance_km: 621.5,
        duration_min: 360.2,
        route_geometry: '_p~iF~ps|U',
        attribution: '© OpenStreetMap contributors',
      }),
      'render_route',
    );
    expect(parsed.state).toBe('ready');
    expect(parsed.data?.kind).toBe('route');
    expect(parsed.data?.from_name).toBe('Madrid');
    expect(parsed.data?.distance_km).toBe(621.5);
  });

  const roadResult = (mode?: string) => ({
    status: 'ok',
    ...(mode === undefined ? {} : { mode }),
    from: { resolved_name: 'Rua da Emenda 45', lat: 38.7106, lng: -9.1426 },
    to: { resolved_name: 'R. de Sao Bernardo 92', lat: 38.7142, lng: -9.1597 },
    distance_km: 1.9,
    duration_min: 24,
    route_geometry: '_p~iF~ps|U',
    attribution: '© OpenStreetMap contributors',
  });

  it('carries the mode of each road route, and treats a result without one as driving', () => {
    for (const mode of ['walking', 'cycling', 'driving']) {
      expect(parseMapsResult(JSON.stringify(roadResult(mode)), 'render_route').data?.mode).toBe(mode);
    }
    expect(parseMapsResult(JSON.stringify(roadResult()), 'render_route').data?.mode).toBe('driving');
  });

  it('parses a transit route with times and steps', () => {
    const parsed = parseMapsResult(
      JSON.stringify({
        ...roadResult('transit'),
        departs: '09:02',
        arrives: '09:20',
        transfers: 0,
        steps: [
          { kind: 'walk', duration_min: 4, to_name: 'Calhariz (Bica)' },
          {
            kind: 'ride',
            vehicle: 'tram',
            line_name: '28E',
            headsign: 'Campo Ourique',
            from_name: 'Calhariz (Bica)',
            to_name: 'Estrela',
            departs: '09:06',
            arrives: '09:16',
            stops_count: 6,
          },
        ],
      }),
      'render_route',
    );
    expect(parsed.state).toBe('ready');
    expect(parsed.data?.mode).toBe('transit');
    expect(parsed.data?.departs).toBe('09:02');
    expect(parsed.data?.steps).toHaveLength(2);
  });

  it('refuses a transit result that has no steps rather than drawing half a card', () => {
    const parsed = parseMapsResult(JSON.stringify(roadResult('transit')), 'render_route');
    expect(parsed.state).toBe('unavailable');
    expect(parsed.data).toBeNull();
  });

  it('says in plain words when no route was found, by mode', () => {
    const message = (mode?: string) =>
      parseMapsResult(JSON.stringify({ status: 'error', code: 'no_route', ...(mode ? { mode } : {}) }), 'render_route')
        .blockedMessage;
    expect(message('transit')).toBe(
      'No public transport route was found between the two places. Walking may still work.',
    );
    expect(message('walking')).toBe('No walking route was found between the two places.');
    expect(message('cycling')).toBe('No cycling route was found between the two places.');
    expect(message()).toBe('No driving route was found between the two places.');
  });

  it('explains a time it could not read', () => {
    const parsed = parseMapsResult(JSON.stringify({ status: 'error', code: 'invalid_time' }), 'render_route');
    expect(parsed.state).toBe('unavailable');
    expect(parsed.blockedMessage).toBe('The time for the trip could not be understood.');
  });

  it('maps not_found to unavailable', () => {
    const parsed = parseMapsResult(JSON.stringify({ status: 'error', code: 'not_found' }), 'render_map');
    expect(parsed.state).toBe('unavailable');
    expect(parsed.data).toBeNull();
  });

  it('maps rate_limited to blocked', () => {
    const parsed = parseMapsResult(JSON.stringify({ status: 'error', code: 'rate_limited' }), 'render_map');
    expect(parsed.state).toBe('blocked');
    expect(parsed.data).toBeNull();
    expect(parsed.blockedMessage).toContain('Try again in a minute');
  });

  it('maps service_unavailable to blocked', () => {
    const parsed = parseMapsResult(JSON.stringify({ status: 'error', code: 'service_unavailable' }), 'render_route');
    expect(parsed.state).toBe('blocked');
  });

  it('handles missing or malformed results as unavailable', () => {
    expect(parseMapsResult(undefined, 'render_map').state).toBe('unavailable');
    expect(parseMapsResult('not json', 'render_map').state).toBe('unavailable');
  });
});
