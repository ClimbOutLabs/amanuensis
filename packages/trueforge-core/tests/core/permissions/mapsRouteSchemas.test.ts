import { MapsRouteResultSchema, MapsTravelModeSchema } from '../../../src/core/permissions/mapsRouteSchemas';
import { requiresNetwork } from '../../../src/core/permissions/networkRequirements';

const base = {
  status: 'ok',
  from: { resolved_name: 'Rua da Emenda', lat: 38.7106, lng: -9.1426 },
  to: { resolved_name: 'Rua de Sao Bernardo', lat: 38.7142, lng: -9.1597 },
  distance_km: 1.9,
  duration_min: 24,
  route_geometry: '_p~iF~ps|U',
  attribution: '© OpenStreetMap contributors',
};

describe('MapsRouteResultSchema', () => {
  it('accepts a result for each road mode', () => {
    for (const mode of ['walking', 'cycling', 'driving']) {
      expect(MapsRouteResultSchema.safeParse({ ...base, mode }).success).toBe(true);
    }
  });

  it('requires steps and times for transit', () => {
    expect(MapsRouteResultSchema.safeParse({ ...base, mode: 'transit' }).success).toBe(false);
    const transit = {
      ...base,
      mode: 'transit',
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
    };
    expect(MapsRouteResultSchema.safeParse(transit).success).toBe(true);
  });

  it('rejects an unknown mode', () => {
    expect(MapsTravelModeSchema.safeParse('hovercraft').success).toBe(false);
    expect(MapsRouteResultSchema.safeParse({ ...base, mode: 'hovercraft' }).success).toBe(false);
  });
});

describe('maps network requirements', () => {
  it('marks the route tool as needing the network so offline mode filters it', () => {
    expect(requiresNetwork({ tool_name: 'render_route', provenance: 'first-party' })).toBe(true);
    expect(requiresNetwork({ tool_name: 'render_map', provenance: 'first-party' })).toBe(true);
  });
});
