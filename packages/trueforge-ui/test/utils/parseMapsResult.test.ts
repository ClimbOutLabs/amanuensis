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
