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

  describe('render_places', () => {
    const okBody = {
      status: 'ok',
      places: [
        {
          name: 'Harbour Family Clinic',
          address: '12 Example Street, Lisbon 1100-000',
          languages: 'English, Portuguese',
          hours: null,
          price: null,
          phone: '+351 210 000 111',
          source_url: 'https://harbour-clinic.example/en',
          source_site: 'harbour-clinic.example',
          fetched_at: '2026-10-17T10:00:00.000Z',
          lat: 38.7,
          lng: -9.1,
          already_in_calendar: true,
        },
        {
          name: 'Garden Health Centre',
          address: '4 Sample Avenue, Lisbon 1200-000',
          languages: null,
          hours: null,
          price: null,
          phone: null,
          source_url: 'https://garden-health.example/doctors',
          source_site: 'garden-health.example',
          fetched_at: '2026-10-17T10:00:00.000Z',
          lat: null,
          lng: null,
          already_in_calendar: false,
        },
      ],
      refused: [],
      attribution: '© OpenStreetMap contributors',
    };

    it('parses places with their found fields, sources and calendar mark', () => {
      const parsed = parseMapsResult(JSON.stringify(okBody), 'render_places');
      expect(parsed.state).toBe('ready');
      expect(parsed.data?.kind).toBe('places');
      expect(parsed.data?.places).toHaveLength(2);
      expect(parsed.data?.places?.[0]).toMatchObject({
        name: 'Harbour Family Clinic',
        languages: 'English, Portuguese',
        hours: null,
        source_site: 'harbour-clinic.example',
        already_in_calendar: true,
      });
      expect(parsed.data?.pins).toEqual([{ name: 'Harbour Family Clinic', lat: 38.7, lng: -9.1 }]);
    });

    it('centres the map on the pinned places', () => {
      const parsed = parseMapsResult(JSON.stringify(okBody), 'render_places');
      expect(parsed.data).toMatchObject({ lat: 38.7, lng: -9.1 });
    });

    it('drops a place whose link is not an ordinary web address', () => {
      const hostile = {
        ...okBody,
        places: [{ ...okBody.places[0], source_url: 'javascript:alert(1)' }, okBody.places[1]],
      };
      const parsed = parseMapsResult(JSON.stringify(hostile), 'render_places');
      expect(parsed.data?.places?.map(place => place.name)).toEqual(['Garden Health Centre']);
    });

    it('explains in plain words when nothing could be checked', () => {
      const parsed = parseMapsResult(JSON.stringify({ status: 'error', code: 'not_grounded' }), 'render_places');
      expect(parsed.state).toBe('unavailable');
      expect(parsed.blockedMessage).toMatch(/could not be checked against the pages/);
    });
  });
});
