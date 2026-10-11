import {
  classifyTier,
  isMapsToolAlwaysTier3,
  type ClassifyContext,
  type SentinelAction,
} from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';

function makeCtx(services?: SentinelServices): ClassifyContext {
  return {
    services: services ?? defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    repository_id: 'r1',
    workspace_cwd: null,
    agent_intent: 'show the user a map',
  };
}

function mapsAction(tool_name: string, canonical_params: Record<string, unknown>): SentinelAction {
  return {
    tool_name,
    canonical_params,
    tool_type: 'truefoundry-system',
    mcp_server_name: 'maps',
    mcp_first_party: true,
    mcp_hints: {},
    maps_hosts: {
      geocoder: 'https://nominatim.openstreetmap.org',
      router: 'https://router.project-osrm.org',
      tile: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    },
  };
}

describe('isMapsToolAlwaysTier3', () => {
  it('matches render_map and render_route only', () => {
    expect(isMapsToolAlwaysTier3('render_map')).toBe(true);
    expect(isMapsToolAlwaysTier3('render_route')).toBe(true);
    expect(isMapsToolAlwaysTier3('web_search')).toBe(false);
    expect(isMapsToolAlwaysTier3('exec')).toBe(false);
    expect(isMapsToolAlwaysTier3('')).toBe(false);
  });
});

describe('maps classifier branch', () => {
  it('classifies render_map as Tier 3', async () => {
    const decision = await classifyTier(mapsAction('render_map', { place_name: 'Paris' }), makeCtx());
    expect(decision.tier).toBe(3);
  });

  it('classifies render_route as Tier 3', async () => {
    const decision = await classifyTier(
      mapsAction('render_route', { from_place: 'Madrid', to_place: 'Barcelona' }),
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
  });

  it('is Tier 3 even when the tool declares readOnlyHint', async () => {
    const action = mapsAction('render_map', { place_name: 'Paris' });
    action.mcp_hints = { read_only_hint: true };
    const decision = await classifyTier(action, makeCtx());
    expect(decision.tier).toBe(3);
  });

  it('names the place string verbatim on the card', async () => {
    const decision = await classifyTier(mapsAction('render_map', { place_name: 'Eiffel Tower' }), makeCtx());
    expect(decision.card?.plain_what).toContain('"Eiffel Tower"');
  });

  it('names both place strings verbatim for render_route', async () => {
    const decision = await classifyTier(
      mapsAction('render_route', { from_place: 'Madrid', to_place: 'Barcelona' }),
      makeCtx(),
    );
    expect(decision.card?.plain_what).toContain('"Madrid"');
    expect(decision.card?.plain_what).toContain('"Barcelona"');
  });

  it('names the poi on the card when given', async () => {
    const decision = await classifyTier(
      mapsAction('render_map', { place_name: 'Paris', poi: 'coffee shop' }),
      makeCtx(),
    );
    expect(decision.card?.plain_what).toContain('"coffee shop"');
  });

  it('sets the destination from the configured hosts, not params', async () => {
    const decision = await classifyTier(mapsAction('render_map', { place_name: 'Paris' }), makeCtx());
    const destination = decision.card?.destination ?? '';
    expect(destination).toContain('nominatim.openstreetmap.org');
    expect(destination).toContain('router.project-osrm.org');
    expect(destination).toContain('tile.openstreetmap.org');
    // Never echoes the place string as the destination.
    expect(destination).not.toContain('Paris');
  });

  it('sets cannot_be_undone and null recipient/amount/parsed_command', async () => {
    const decision = await classifyTier(mapsAction('render_map', { place_name: 'Paris' }), makeCtx());
    expect(decision.card?.cannot_be_undone).toBe('Once the place names leave this machine they cannot be taken back.');
    expect(decision.card?.recipient).toBeNull();
    expect(decision.card?.amount).toBeNull();
    expect(decision.card?.parsed_command).toBeNull();
  });

  it('reflects a self-hosted stack on the card', async () => {
    const action = mapsAction('render_map', { place_name: 'Paris' });
    action.maps_hosts = {
      geocoder: 'https://geocode.example.internal',
      router: 'https://routes.example.internal',
      tile: 'https://tiles.example.internal/{z}/{x}/{y}.png',
    };
    const decision = await classifyTier(action, makeCtx());
    expect(decision.card?.destination).toContain('geocode.example.internal');
    expect(decision.card?.plain_what).toContain('geocode.example.internal');
  });
});
