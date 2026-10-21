import {
  classifyHostToolCall,
  classifyTier,
  type ClassifyContext,
  type SentinelAction,
} from '../../../src/core/permissions/classifier';
import {
  createSentinelHostContext,
  defaultSentinelServices,
  forUnattendedRun,
  type SentinelServices,
} from '../../../src/core/permissions/context';
import { appendOutboundTrace, collectOutboundStrings } from '../../../src/core/permissions/outboundGuard';
import { createWebSearchTurnState, recordPrivateReadText } from '../../../src/core/permissions/webSearch';

const MAIL = JSON.stringify({
  from: 'Maria Costa <maria.costa@harbour-clinic.example>',
  to: 'you@example.test',
  body:
    'Please bring your booking reference 4417829 and call +351 912 345 678 before Friday. ' +
    'The clinic is at 12 Example Street, Lisbon 1100-000.',
});

const MAPS_HOSTS = {
  geocoder: 'https://nominatim.openstreetmap.org',
  router: 'https://router.project-osrm.org',
  walking: 'https://foot.example.test/routed-foot',
  cycling: 'https://bike.example.test/routed-bike',
  transit: 'https://transit.example.test/api/v6',
  tile: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
};

function makeCtx(input: { unattended?: boolean; services?: Partial<SentinelServices> } = {}): ClassifyContext {
  const base = { ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }), ...input.services };
  return {
    services: input.unattended === true ? forUnattendedRun(base) : base,
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

const SEARCH: SentinelAction = {
  tool_name: 'web_search',
  canonical_params: { query: 'best tapas in Lisbon' },
  tool_type: 'mcp',
  mcp_server_name: 'search',
  mcp_search_provider: true,
  mcp_search_tool: true,
  mcp_hints: { read_only_hint: true, open_world_hint: true },
};

function searchFor(query: string): SentinelAction {
  return { ...SEARCH, canonical_params: { query } };
}

const MAIL_READ: SentinelAction = {
  tool_name: 'read_email',
  canonical_params: { message_id: 'm1' },
  tool_type: 'truefoundry-system',
  mcp_server_name: 'gmail',
  mcp_hints: { read_only_hint: true, open_world_hint: true },
};

function mapsAction(tool_name: string, canonical_params: Record<string, unknown>): SentinelAction {
  return {
    tool_name,
    canonical_params,
    tool_type: 'truefoundry-system',
    mcp_server_name: 'maps',
    mcp_first_party: true,
    mcp_hints: {},
    maps_hosts: MAPS_HOSTS,
  };
}

/** A silent search that went out, as the tool set records its text after the call runs. */
function sentSilently(ctx: ClassifyContext, query: string): void {
  const strings = collectOutboundStrings({ query });
  if (strings !== undefined) {
    ctx.web_search.sentText = appendOutboundTrace({ earlier: ctx.web_search.sentText, strings });
  }
}

/** A mail read whose result the chat has received, as the post-call step records it. */
async function readMail(ctx: ClassifyContext): Promise<void> {
  await classifyTier(MAIL_READ, ctx);
  recordPrivateReadText({ state: ctx.web_search, text: MAIL });
}

describe('a web search after a mail read, checked against what the mail said', () => {
  it('runs a clean query silently and names its reason', async () => {
    const ctx = makeCtx();
    await readMail(ctx);
    const decision = await classifyTier(SEARCH, ctx);
    expect(decision).toMatchObject({
      tier: 1,
      reason: 'mcp_search_after_read_checked',
      silent_search_query: 'best tapas in Lisbon',
    });
    expect(decision.reason_detail).toBe('Searched: best tapas in Lisbon');
  });

  it('asks when the query carries a sender name', async () => {
    const ctx = makeCtx();
    await readMail(ctx);
    expect(await classifyTier(searchFor('Maria Costa clinic reviews'), ctx)).toMatchObject({
      tier: 3,
      reason: 'mcp_search_after_private_read',
      auto_deny: null,
    });
  });

  it('asks when the query carries an email address', async () => {
    const ctx = makeCtx();
    await readMail(ctx);
    expect(await classifyTier(searchFor('maria.costa@harbour-clinic.example reviews'), ctx)).toMatchObject({
      tier: 3,
      reason: 'mcp_search_after_private_read',
    });
  });

  it('asks when the query carries a phone number', async () => {
    const ctx = makeCtx();
    await readMail(ctx);
    expect(await classifyTier(searchFor('call 351 912 345 678 reviews'), ctx)).toMatchObject({
      tier: 3,
      reason: 'mcp_search_after_private_read',
    });
  });

  it('asks when the query carries an order or booking number', async () => {
    const ctx = makeCtx();
    await readMail(ctx);
    expect(await classifyTier(searchFor('booking 4417829 status'), ctx)).toMatchObject({
      tier: 3,
      reason: 'mcp_search_after_private_read',
    });
  });

  it('asks when the query copies five words from the mail', async () => {
    const ctx = makeCtx();
    await readMail(ctx);
    expect(await classifyTier(searchFor('please bring your booking reference tapas'), ctx)).toMatchObject({
      tier: 3,
      reason: 'mcp_search_after_private_read',
    });
  });

  it('asks when a phrase is split across two searches', async () => {
    const ctx = makeCtx();
    await readMail(ctx);
    expect(await classifyTier(searchFor('please bring your'), ctx)).toMatchObject({ tier: 1 });
    sentSilently(ctx, 'please bring your');
    expect(await classifyTier(searchFor('booking reference tapas'), ctx)).toMatchObject({
      tier: 3,
      reason: 'mcp_search_after_private_read',
    });
  });

  it('keeps asking when the search setting is off', async () => {
    const ctx = makeCtx({ services: { searchWithoutAsking: () => Promise.resolve(false) } });
    await readMail(ctx);
    expect(await classifyTier(SEARCH, ctx)).toMatchObject({ tier: 3, reason: 'mcp_search_setting_ask' });
  });

  it('asks, as before, when the mail text is not available to compare', async () => {
    const ctx = makeCtx();
    await classifyTier(MAIL_READ, ctx);
    expect(await classifyTier(SEARCH, ctx)).toMatchObject({ tier: 3, reason: 'mcp_search_after_private_read' });
  });

  it('skips a checked query in a scheduled run and says why, without holding it for the owner', async () => {
    const ctx = makeCtx({ unattended: true });
    await readMail(ctx);
    const decision = await classifyTier(searchFor('Maria Costa clinic reviews'), ctx);
    expect(decision).toMatchObject({ tier: 3, reason: 'auto_denied', auto_deny: 'private_text_check' });
    expect(decision.owner_message).toBe(
      'One lookup was skipped, because it would have shared something from your mail or calendar.',
    );
  });

  it('still runs a clean query in a scheduled run', async () => {
    const ctx = makeCtx({ unattended: true });
    await readMail(ctx);
    expect(await classifyTier(SEARCH, ctx)).toMatchObject({ tier: 1, reason: 'mcp_search_after_read_checked' });
  });

  it('keeps asking after a secret read in the same chat, whatever the query', async () => {
    const ctx = makeCtx();
    const sentinel = createSentinelHostContext({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'c1',
      services: ctx.services,
      web_search: ctx.web_search,
    });
    const secret = await classifyHostToolCall({
      sentinel,
      repository_id: null,
      workspace_cwd: null,
      action: {
        tool_name: 'read_key',
        canonical_params: { path: '/home/someone/.ssh/id_ed25519' },
        tool_type: 'mcp',
        mcp_server_name: 'files',
        mcp_hints: { read_only_hint: true, open_world_hint: false },
      },
    });
    expect(secret.sensitive_read).toBe(true);
    recordPrivateReadText({ state: ctx.web_search, text: MAIL });
    expect(await classifyTier(SEARCH, ctx)).toMatchObject({ tier: 3, reason: 'mcp_search_after_private_read' });
  });
});

describe('a map after a mail read, checked against what the mail said', () => {
  const withMaps = (services: Partial<SentinelServices> = {}) => ({
    mapsWithoutAsking: () => Promise.resolve(true),
    ...services,
  });

  it('runs when the place is a street address from the mail', async () => {
    const ctx = makeCtx({ services: withMaps() });
    await readMail(ctx);
    const decision = await classifyTier(
      mapsAction('render_map', { place_name: '12 Example Street, Lisbon 1100-000' }),
      ctx,
    );
    expect(decision).toMatchObject({ tier: 1, reason: 'maps_after_read_checked' });
    expect(decision.reason_detail).toBe('Map: 12 Example Street, Lisbon 1100-000');
  });

  it('asks when the place is a sender name', async () => {
    const ctx = makeCtx({ services: withMaps() });
    await readMail(ctx);
    expect(await classifyTier(mapsAction('render_map', { place_name: 'Maria Costa' }), ctx)).toMatchObject({
      tier: 3,
      reason: 'maps_tool',
    });
  });

  it('skips the place in a scheduled run when it is a sender name', async () => {
    const ctx = makeCtx({ unattended: true, services: withMaps() });
    await readMail(ctx);
    expect(await classifyTier(mapsAction('render_map', { place_name: 'Maria Costa' }), ctx)).toMatchObject({
      tier: 3,
      reason: 'auto_denied',
      auto_deny: 'private_text_check',
    });
  });

  it('keeps today’s card when the maps setting is off', async () => {
    const ctx = makeCtx({ services: { mapsWithoutAsking: () => Promise.resolve(false) } });
    await readMail(ctx);
    expect(await classifyTier(mapsAction('render_map', { place_name: '12 Example Street' }), ctx)).toMatchObject({
      tier: 3,
      reason: 'maps_tool',
    });
  });

  it('asks when the mail text is not available to compare', async () => {
    const ctx = makeCtx({ services: withMaps() });
    await classifyTier(MAIL_READ, ctx);
    expect(await classifyTier(mapsAction('render_map', { place_name: '12 Example Street' }), ctx)).toMatchObject({
      tier: 3,
      reason: 'maps_tool',
    });
  });
});
