import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

/**
 * Silent search is a promise about ordinary lookups only. With the search-without-asking switch
 * explicitly on, a query carrying a key this computer keeps is still held, and a single part of a
 * query past the length limit still asks. An ordinary short lookup runs.
 */

const HELD_VALUE = 'invented-server-value-9021';

function makeCtx(): ClassifyContext {
  const services = {
    ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    searchWithoutAsking: () => Promise.resolve(true),
    outboundSecrets: () => Promise.resolve([HELD_VALUE]),
  };
  return {
    services,
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

/** A call to the person's designated search provider. */
function search(objective: string): SentinelAction {
  return {
    tool_name: 'web_search',
    canonical_params: { objective },
    tool_type: 'mcp',
    mcp_server_name: 'parallel-web',
    mcp_server_host: 'search.parallel.ai',
    mcp_hints: {},
    mcp_search_provider: true,
    mcp_search_tool: true,
  };
}

describe('silent search still holds what a lookup must never carry out', () => {
  test('a query carrying a key this computer keeps is held, and the key is never shown on the card', async () => {
    const decision = await classifyTier(search(`status of the token ${HELD_VALUE} please`), makeCtx());
    expect(decision).toMatchObject({ tier: 3, reason: 'mcp_search_guard' });
    expect(JSON.stringify(decision)).not.toContain(HELD_VALUE);
  });

  test('a single part past the length limit asks, even though it holds nothing private', async () => {
    const objective = `harbour ferry timetables ${'and sailing notes '.repeat(12)}`.trim();
    expect(objective.length).toBeGreaterThan(200);
    const decision = await classifyTier(search(objective), makeCtx());
    expect(decision).toMatchObject({ tier: 3, reason: 'mcp_search_guard' });
  });

  test('an ordinary short lookup still runs without a card', async () => {
    const decision = await classifyTier(search('harbour ferry timetables tomorrow'), makeCtx());
    expect(decision.tier).toBe(1);
    expect(decision.card).toBeNull();
  });
});
