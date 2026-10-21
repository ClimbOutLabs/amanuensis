import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import {
  createWebSearchTurnState,
  markPrivateDataRead,
  recordPrivateReadText,
  SILENT_SEARCH_LIMIT,
} from '../../../src/core/permissions/webSearch';

const MAIL = JSON.stringify({
  from: 'Maria Costa <maria.costa@harbour-clinic.example>',
  body: 'Please bring your booking reference 4417829 before Friday.',
});

const MAPS_HOSTS = {
  geocoder: 'https://nominatim.openstreetmap.org',
  router: 'https://router.project-osrm.org',
  walking: 'https://foot.example.test/routed-foot',
  cycling: 'https://bike.example.test/routed-bike',
  transit: 'https://transit.example.test/api/v6',
  tile: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
};

function makeCtx(input: { conversation_id?: string; services?: Partial<SentinelServices> } = {}): ClassifyContext {
  return {
    services: { ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }), ...input.services },
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: input.conversation_id ?? 'c1',
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

/** A private read whose result text the chat keeps, as the post-call step records it. */
async function readMail(ctx: ClassifyContext): Promise<void> {
  await classifyTier(MAIL_READ, ctx);
  markPrivateDataRead(ctx.web_search);
  recordPrivateReadText({ state: ctx.web_search, text: MAIL });
}

/** The chat has read a secret, which the private-read hold checks for. */
function markSecretRead(ctx: ClassifyContext): void {
  ctx.services.private_reads.markPrivateDataRead(ctx);
}

/** The chat's saved grant, as the session hands it to a turn that starts after the owner allowed it. */
function grantChat(ctx: ClassifyContext): void {
  ctx.web_search.searchChatGranted = true;
}

describe('a held search after a private read offers the chat choice', () => {
  it('holds the search with the private-read reason', async () => {
    const ctx = makeCtx();
    markSecretRead(ctx);
    expect(await classifyTier(SEARCH, ctx)).toMatchObject({
      tier: 3,
      reason: 'mcp_search_after_private_read',
    });
  });
});

describe('a chat grant from "Allow searches in this chat"', () => {
  it('runs a plain search in the chat silently under its own reason', async () => {
    const ctx = makeCtx();
    markSecretRead(ctx);
    grantChat(ctx);
    expect(await classifyTier(SEARCH, ctx)).toMatchObject({
      tier: 1,
      reason: 'mcp_search_chat_granted',
      silent_search_query: 'best tapas in Lisbon',
    });
  });

  it('still holds a search that carries text from the private read', async () => {
    const ctx = makeCtx();
    await readMail(ctx);
    markSecretRead(ctx);
    grantChat(ctx);
    expect(await classifyTier(searchFor('Maria Costa clinic reviews'), ctx)).toMatchObject({
      tier: 3,
      reason: 'mcp_search_after_private_read',
    });
  });

  it('still holds a search that names a URL the search never returned', async () => {
    const ctx = makeCtx();
    markSecretRead(ctx);
    grantChat(ctx);
    expect(await classifyTier(searchFor('https://example.test/unseen-page'), ctx)).toMatchObject({
      tier: 3,
      reason: 'mcp_search_unreturned_url',
    });
  });

  it('still holds a search that carries a key', async () => {
    const ctx = makeCtx();
    markSecretRead(ctx);
    grantChat(ctx);
    expect(await classifyTier(searchFor('wsk-live-synthetic000111222333'), ctx)).toMatchObject({
      tier: 3,
      reason: 'mcp_search_guard',
    });
  });

  it('still holds once the chat has used its silent searches', async () => {
    const ctx = makeCtx();
    markSecretRead(ctx);
    grantChat(ctx);
    ctx.web_search.silentSearches = SILENT_SEARCH_LIMIT;
    expect(await classifyTier(SEARCH, ctx)).toMatchObject({ tier: 3, reason: 'mcp_search_limit' });
  });

  it('does not lift the private-read hold for a map after a private read', async () => {
    const ctx = makeCtx({ services: { mapsWithoutAsking: () => Promise.resolve(true) } });
    markSecretRead(ctx);
    grantChat(ctx);
    const decision = await classifyTier(
      {
        tool_name: 'render_map',
        canonical_params: { place_name: '12 Example Street, Lisbon 1100-000' },
        tool_type: 'truefoundry-system',
        mcp_server_name: 'maps',
        mcp_first_party: true,
        mcp_hints: {},
        maps_hosts: MAPS_HOSTS,
      },
      ctx,
    );
    expect(decision.tier).toBe(3);
    expect(decision.reason).not.toMatch(/^mcp_maps.*silent/);
  });

  it('does not reach another chat', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const chatA = makeCtx({ conversation_id: 'chat-a', services });
    const chatB = makeCtx({ conversation_id: 'chat-b', services });
    markSecretRead(chatA);
    markSecretRead(chatB);
    grantChat(chatA);
    expect(await classifyTier(SEARCH, chatA)).toMatchObject({ tier: 1, reason: 'mcp_search_chat_granted' });
    expect(await classifyTier(SEARCH, chatB)).toMatchObject({ tier: 3, reason: 'mcp_search_after_private_read' });
  });
});

describe('the held search card folds the search service fields', () => {
  it('names the service fields separately so the card can fold them, while still listing every argument', async () => {
    const ctx = makeCtx();
    markSecretRead(ctx);
    const decision = await classifyTier(
      {
        ...SEARCH,
        canonical_params: { query: 'best tapas in Lisbon', session_id: 'sess-123', model_name: 'search-model-1' },
        mcp_search_plumbing_fields: ['session_id', 'model_name'],
      },
      ctx,
    );
    expect(decision).toMatchObject({ tier: 3, reason: 'mcp_search_after_private_read' });
    expect(decision.card?.outbound_text).toContain('best tapas in Lisbon');
    expect(decision.card?.outbound_text).toContain('sess-123');
    expect(decision.card?.outbound_plumbing_text).not.toContain('best tapas in Lisbon');
    expect(decision.card?.outbound_plumbing_text).toContain('sess-123');
    expect(decision.card?.outbound_plumbing_text).toContain('search-model-1');
  });
});
