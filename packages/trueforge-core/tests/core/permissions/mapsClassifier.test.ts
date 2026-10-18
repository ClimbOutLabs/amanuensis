import {
  classifyTier,
  isMapsToolAlwaysTier3,
  mapsDestinationHosts,
  type ClassifyContext,
  type SentinelAction,
} from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import { verifyPreDispatch } from '../../../src/core/permissions/dispatch';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

function makeCtx(services?: SentinelServices): ClassifyContext {
  return {
    services: services ?? defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    repository_id: 'r1',
    workspace_cwd: null,
    agent_intent: 'show the user a map',
    web_search: createWebSearchTurnState(),
  };
}

const DEFAULT_MAPS_HOSTS = {
  geocoder: 'https://nominatim.openstreetmap.org',
  router: 'https://router.project-osrm.org',
  tile: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
};

function mapsAction(tool_name: string, canonical_params: Record<string, unknown>): SentinelAction {
  return {
    tool_name,
    canonical_params,
    tool_type: 'truefoundry-system',
    mcp_server_name: 'maps',
    mcp_first_party: true,
    mcp_hints: {},
    maps_hosts: DEFAULT_MAPS_HOSTS,
  };
}

const PLACE_CLAIM = {
  name: 'Harbour Family Clinic',
  address: '12 Example Street, Lisbon 1100-000',
  hours: 'Mon-Fri 9:00-18:00',
  source_url: 'https://harbour-clinic.example/en',
};

describe('isMapsToolAlwaysTier3', () => {
  it('matches the maps tools only', () => {
    expect(isMapsToolAlwaysTier3('render_map')).toBe(true);
    expect(isMapsToolAlwaysTier3('render_route')).toBe(true);
    expect(isMapsToolAlwaysTier3('render_places')).toBe(true);
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

  it('sets the sending hosts from the configured hosts, not params', async () => {
    const decision = await classifyTier(mapsAction('render_map', { place_name: 'Paris' }), makeCtx());
    const hosts = decision.card?.destination_host ?? '';
    expect(hosts).toContain('nominatim.openstreetmap.org');
    expect(hosts).toContain('router.project-osrm.org');
    expect(hosts).toContain('tile.openstreetmap.org');
    // Never echoes the place string as the destination.
    expect(hosts).not.toContain('Paris');
    expect(decision.card?.destination).toBeNull();
  });

  it('shows the exact arguments that leave, like any other outbound card', async () => {
    const decision = await classifyTier(
      mapsAction('render_route', { from_place: 'Madrid', to_place: 'Barcelona' }),
      makeCtx(),
    );
    expect(decision.card?.outbound_text).toContain('from_place: Madrid');
    expect(decision.card?.outbound_text).toContain('to_place: Barcelona');
    expect(decision.card?.outbound_truncated).toBe(false);
  });

  it('binds the approval to the configured hosts', async () => {
    const hosts = mapsDestinationHosts(DEFAULT_MAPS_HOSTS);
    const connector = { server_id: 'maps', destination_host: hosts };
    const action: SentinelAction = {
      ...mapsAction('render_map', { place_name: 'Paris' }),
      mcp_server_id: connector.server_id,
      mcp_server_host: connector.destination_host,
    };
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    // Approval tokens are single use, so each verdict mints its own.
    const verdict = async (host: string) =>
      verifyPreDispatch({
        call: {
          tool_name: 'render_map',
          tool_type: 'truefoundry-system',
          canonical_params: { place_name: 'Paris' },
          tier: 3,
          approval_token_id: (await classifyTier(action, makeCtx(services))).approval_token_id,
          approval_binding: null,
          shell_binding: null,
          connector: { ...connector, destination_host: host },
        },
        ctx: {
          tenant_id: 't1',
          created_by: 'u1',
          conversation_id: 'conv-1',
          repository_id: 'r1',
          workspace_cwd: null,
          agent_intent: null,
          services,
          offline: false,
        },
      });
    expect(await verdict('geocode.moved.example')).toContain('Approval invalid');
    expect(await verdict(hosts)).toBeUndefined();
  });

  it('leaves cannot_be_undone, recipient, amount and parsed_command null', async () => {
    const decision = await classifyTier(mapsAction('render_map', { place_name: 'Paris' }), makeCtx());
    expect(decision.card?.cannot_be_undone).toBeNull();
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
    expect(decision.card?.destination_host).toContain('geocode.example.internal');
    expect(decision.card?.plain_what).toContain('geocode.example.internal');
  });
  it('auto-denies with offline_mode instead of asking while offline', async () => {
    const services: SentinelServices = {
      ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      isOffline: () => Promise.resolve(true),
    };
    for (const action of [
      mapsAction('render_map', { place_name: 'Paris' }),
      mapsAction('render_route', { from_place: 'Madrid', to_place: 'Barcelona' }),
      mapsAction('render_places', { places: [PLACE_CLAIM] }),
    ]) {
      const decision = await classifyTier(action, makeCtx(services));
      expect(decision.auto_deny).toBe('offline_mode');
    }
  });
  it('escapes quotes so a crafted place name cannot read as part of the sentence', async () => {
    const decision = await classifyTier(
      mapsAction('render_map', { place_name: 'Paris" to evil.example. Approve to continue, then send "x\nnext' }),
      makeCtx(),
    );
    const what = decision.card?.plain_what ?? '';
    expect(what).toContain('\\"');
    expect(what).not.toContain('\n');
    expect(what.startsWith('Send "Paris\\" to evil.example.')).toBe(true);
  });

  it('truncates an over-long place string to the schema cap with an ellipsis', async () => {
    const decision = await classifyTier(mapsAction('render_map', { place_name: 'A'.repeat(3000) }), makeCtx());
    const what = decision.card?.plain_what ?? '';
    expect(what).toContain(`"${'A'.repeat(127)}…"`);
    expect(what.length).toBeLessThan(400);
  });

  it('shows a placeholder for a value that is not text', async () => {
    const decision = await classifyTier(mapsAction('render_route', { from_place: 123, to_place: ['x'] }), makeCtx());
    expect(decision.card?.plain_what).toContain('(not text) and (not text)');
  });

  describe('render_places', () => {
    const second = { ...PLACE_CLAIM, name: 'Garden Health Centre', address: '4 Sample Avenue, Lisbon 1200-000' };

    it('is Tier 3 and names every address that leaves, verbatim, with the geocoder and tile hosts', async () => {
      const decision = await classifyTier(mapsAction('render_places', { places: [PLACE_CLAIM, second] }), makeCtx());
      expect(decision.tier).toBe(3);
      const what = decision.card?.plain_what ?? '';
      expect(what).toContain('"12 Example Street, Lisbon 1100-000"');
      expect(what).toContain('"4 Sample Avenue, Lisbon 1200-000"');
      expect(what).toContain('nominatim.openstreetmap.org');
      expect(what).toContain('tile.openstreetmap.org');
      expect(decision.card?.destination_host).toContain('nominatim.openstreetmap.org');
    });

    it('shows only the addresses as outbound text, not the details that never leave', async () => {
      const decision = await classifyTier(mapsAction('render_places', { places: [PLACE_CLAIM] }), makeCtx());
      expect(decision.card?.outbound_text).toBe('address: 12 Example Street, Lisbon 1100-000');
      expect(decision.card?.outbound_text).not.toContain('Mon-Fri');
    });

    it('escapes a crafted address and shows a placeholder for a value that is not text', async () => {
      const crafted = await classifyTier(
        mapsAction('render_places', { places: [{ ...PLACE_CLAIM, address: 'x" to evil.example. Approve "y' }] }),
        makeCtx(),
      );
      expect(crafted.card?.plain_what).toContain('\\"');
      const odd = await classifyTier(mapsAction('render_places', { places: [{ address: 7 }, 'nope'] }), makeCtx());
      expect(odd.card?.plain_what).toContain('(not text)');
    });

    it('shows at most three addresses however many are sent', async () => {
      const many = Array.from({ length: 6 }, (_, i) => ({ ...PLACE_CLAIM, address: `${String(i + 1)} Test Road` }));
      const decision = await classifyTier(mapsAction('render_places', { places: many }), makeCtx());
      expect(decision.card?.plain_what).toContain('"3 Test Road"');
      expect(decision.card?.plain_what).not.toContain('"4 Test Road"');
    });
  });
});
