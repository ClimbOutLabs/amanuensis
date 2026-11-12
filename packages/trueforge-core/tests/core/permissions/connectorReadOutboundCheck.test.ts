import { allowsChatApproval, allowsToolGrant } from '../../../src/core/mcp/approvalGrant';
import { stampSentinelDecision } from '../../../src/core/mcp/ToolSet';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { FIRST_PARTY_TOOL_REASON } from '../../../src/core/permissions/connectorTrust';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import { CONNECTOR_READ_GUARD_REASON } from '../../../src/core/permissions/tier';
import { TOOL_GRANT_REASON } from '../../../src/core/permissions/toolGrants';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

/** Synthetic values only: a test card number that passes the card check, and a made-up key the host holds. */
const CARD_NUMBER = '4111 1111 1111 1111';
const HELD_KEY = 'zq-held-key-93-synthetic';

const SERVER = 'chatlog';
const SERVER_HOST = 'chatlog.example';

async function servicesWithGrants(tools: readonly string[]): Promise<SentinelServices> {
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  services.outboundSecrets = () => Promise.resolve([HELD_KEY]);
  for (const tool_name of tools) {
    await services.tool_grants.recordToolGrant({
      tenant_id: 't1',
      created_by: 'u1',
      mcp_server_name: SERVER,
      tool_name,
      mcp_server_host: SERVER_HOST,
    });
  }
  return services;
}

function makeCtx(services: SentinelServices): ClassifyContext {
  return {
    services,
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

/**
 * A read on a connector the person added. A search is known as a read by its name; a read by id is one because
 * the connector says it is read-only and reaches nothing else.
 */
function grantedRead(tool_name: string, canonical_params: Record<string, unknown>): SentinelAction {
  return {
    tool_name,
    canonical_params,
    tool_type: 'mcp',
    mcp_server_name: SERVER,
    mcp_server_host: SERVER_HOST,
    mcp_hints: tool_name === 'search_messages' ? {} : { read_only_hint: true, open_world_hint: false },
  };
}

/** A read on one of the host's own connectors, which says it is read-only and reaches nothing else. */
function firstPartyRead(canonical_params: Record<string, unknown>): SentinelAction {
  return {
    tool_name: 'lookup_record',
    canonical_params,
    tool_type: 'mcp',
    mcp_server_name: 'records',
    mcp_first_party: true,
    mcp_hints: { read_only_hint: true, open_world_hint: false },
  };
}

describe('a connector read the person always allows is checked before it runs without a card', () => {
  it('runs an ordinary search without a card', async () => {
    const ctx = makeCtx(await servicesWithGrants(['search_messages']));
    const decision = await classifyTier(grantedRead('search_messages', { query: 'lunch on friday' }), ctx);
    expect(decision).toMatchObject({ tier: 1, reason: TOOL_GRANT_REASON, card: null, auto_deny: null });
  });

  it.each([
    ['a payment card number', { query: `receipt ${CARD_NUMBER}` }, 'payment card number'],
    ['a password', { query: 'wifi password: hunter2-open' }, 'password or key'],
    ['one part longer than a search may be', { query: 'budget '.repeat(36) }, 'a lot of text'],
    ['a long block of coded text', { query: 'notes c2VjcmV0IGtleSBoZXJlIGZvciB5b3U=' }, 'coded text'],
  ])('asks when the search carries %s, and says why', async (_label, params, why) => {
    const ctx = makeCtx(await servicesWithGrants(['search_messages']));
    const decision = await classifyTier(grantedRead('search_messages', params), ctx);
    expect(decision).toMatchObject({ tier: 3, reason: CONNECTOR_READ_GUARD_REASON, auto_deny: null });
    expect(decision.card?.plain_what).toMatch(/^Look this up on chatlog\? /);
    expect(decision.card?.plain_what).toContain(why);
    expect(decision.card?.outbound_text).toContain('query: ');
    expect(typeof decision.approval_token_id).toBe('string');
  });

  it('does not run a search that carries a key this computer holds, and shows no card with the key on it', async () => {
    const ctx = makeCtx(await servicesWithGrants(['search_messages']));
    const decision = await classifyTier(grantedRead('search_messages', { query: `status ${HELD_KEY}` }), ctx);
    expect(decision).toMatchObject({ tier: 3, auto_deny: 'outbound_guard', card: null });
    expect(decision.reason_detail).not.toContain(HELD_KEY);
  });

  it('never offers an always-allow answer on that card, so the next such search asks again', async () => {
    const ctx = makeCtx(await servicesWithGrants(['search_messages']));
    const decision = await classifyTier(grantedRead('search_messages', { query: `receipt ${CARD_NUMBER}` }), ctx);
    const info = {
      is_approval_required: true,
      effect: 'inspect' as const,
      mcp_server_name: SERVER,
      mcp_server_id: SERVER,
      original_tool_name: 'search_messages',
      type: 'mcp' as const,
      ...stampSentinelDecision({ decision }),
    };
    expect(allowsChatApproval(info)).toBe(false);
    expect(allowsToolGrant(info)).toBe(false);
  });

  it('remembers what a silent read sent, so a key split over two reads is still seen', async () => {
    const ctx = makeCtx(await servicesWithGrants(['search_messages']));
    const first = await classifyTier(grantedRead('search_messages', { query: HELD_KEY.slice(0, 12) }), ctx);
    expect(first.tier).toBe(1);
    const second = await classifyTier(grantedRead('search_messages', { query: HELD_KEY.slice(12) }), ctx);
    expect(second).toMatchObject({ tier: 3, auto_deny: 'outbound_guard' });
  });
});

describe('a read by record id still runs without a card', () => {
  it.each([
    ['a page id', 'get_page', { page_id: '0f3a9c2e7b1d4e6f8a5b3c2d1e0f9a8b' }],
    ['a commit', 'get_commit', { sha: '9fceb02d0ae598e95dc970b74767f19372d61af8' }],
    ['a message id', 'get_message', { id: '18c2a3f4b5d6e7f8' }],
  ])('reads by %s', async (_label, tool_name, params) => {
    const ctx = makeCtx(await servicesWithGrants([tool_name]));
    const decision = await classifyTier(grantedRead(tool_name, params), ctx);
    expect(decision).toMatchObject({ tier: 1, reason: TOOL_GRANT_REASON, card: null });
  });

  it('asks when an id field carries more than one short code', async () => {
    const ctx = makeCtx(await servicesWithGrants(['get_page']));
    const decision = await classifyTier(
      grantedRead('get_page', { page_id: '0f3a9c2e7b1d4e6f8a5b3c2d1e0f9a8b0f3a9c2e7b1d4e6f8a5b3c2d1e0f9a8b' }),
      ctx,
    );
    expect(decision).toMatchObject({ tier: 3, reason: CONNECTOR_READ_GUARD_REASON });
  });

  it('reads by a page id next to a short workspace id', async () => {
    const ctx = makeCtx(await servicesWithGrants(['get_page']));
    const decision = await classifyTier(
      grantedRead('get_page', { workspace_id: 'T024BE7LD', page_id: '0f3a9c2e7b1d4e6f8a5b3c2d1e0f9a8b' }),
      ctx,
    );
    expect(decision).toMatchObject({ tier: 1, reason: TOOL_GRANT_REASON, card: null });
  });

  it('asks when a second id field carries a short code too', async () => {
    const ctx = makeCtx(await servicesWithGrants(['get_page']));
    const decision = await classifyTier(
      grantedRead('get_page', {
        page_id: '0f3a9c2e7b1d4e6f8a5b3c2d1e0f9a8b',
        parent_id: '7c1e5a9d3b2f4086a1c3e5d7f9b0a2c4',
      }),
      ctx,
    );
    expect(decision).toMatchObject({ tier: 3, reason: CONNECTOR_READ_GUARD_REASON });
  });

  it('asks when many id fields each carry a short code', async () => {
    const ctx = makeCtx(await servicesWithGrants(['get_page']));
    const params = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`part${index}_id`, `Zm9vYmFyYmF6cXV4${index}Y29ycGdlZ3JhdWx0Z2FycGx5`]),
    );
    const decision = await classifyTier(grantedRead('get_page', params), ctx);
    expect(decision).toMatchObject({ tier: 3, reason: CONNECTOR_READ_GUARD_REASON });
  });

  it('still stops a key this computer holds in an id field', async () => {
    const ctx = makeCtx(await servicesWithGrants(['get_page']));
    const decision = await classifyTier(grantedRead('get_page', { page_id: HELD_KEY }), ctx);
    expect(decision).toMatchObject({ tier: 3, auto_deny: 'outbound_guard' });
  });
});

describe("a read on one of the host's own connectors is checked the same way", () => {
  it('runs an ordinary read without a card', async () => {
    const ctx = makeCtx(await servicesWithGrants([]));
    const decision = await classifyTier(firstPartyRead({ query: 'invoice from march' }), ctx);
    expect(decision).toMatchObject({ tier: 1, reason: FIRST_PARTY_TOOL_REASON, card: null });
  });

  it('asks when the read carries a payment card number', async () => {
    const ctx = makeCtx(await servicesWithGrants([]));
    const decision = await classifyTier(firstPartyRead({ query: `receipt ${CARD_NUMBER}` }), ctx);
    expect(decision).toMatchObject({ tier: 3, reason: CONNECTOR_READ_GUARD_REASON, auto_deny: null });
  });

  it('does not run a read that carries a key this computer holds', async () => {
    const ctx = makeCtx(await servicesWithGrants([]));
    const decision = await classifyTier(firstPartyRead({ query: HELD_KEY }), ctx);
    expect(decision).toMatchObject({ tier: 3, auto_deny: 'outbound_guard', card: null });
  });
});
