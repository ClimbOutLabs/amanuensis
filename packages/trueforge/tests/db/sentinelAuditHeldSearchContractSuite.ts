/**
 * Backend-agnostic contract: a web search held by the outbound guard reaches `sentinel_audit` with the
 * rule that fired and never the text it caught, whether the owner approves, denies, or has not answered.
 * Rows are kept and never expire, so the text must never be written in the first place.
 */
import {
  ToolSet,
  createSentinelHostContext,
  defaultSentinelServices,
  recordHeldActionAudit,
  type ToolSource,
} from '@truefoundry/trueforge-core/core';

import type { ISentinelAuditStore } from '../../src/db/sentinelAuditStore';

const OWNER = { tenant_id: 't1', created_by: 'u1', conversation_id: 's1' };
const SERVER_KEY = 'synthetic-provider-key-000111';
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlMTIzNDU2'].join('.');
const CARD_NUMBER = 'refund to 4111 1111 1111 1111';
const PASSWORD_LABEL = 'password: hunter2hunter2';

function searchSource(): ToolSource {
  const schema = { type: 'object' as const, properties: {} };
  return {
    name: 'finder',
    id: 'finder',
    listTools: () =>
      Promise.resolve({
        result: {
          tools: [
            {
              name: 'lookup',
              description: 'Looks things up on the web.',
              inputSchema: schema,
              annotations: { readOnlyHint: true, openWorldHint: true },
              preload: true,
            },
          ],
        },
        wasInitialized: undefined,
      }),
    callTool: () => Promise.reject(new Error('a held search is never dispatched here')),
    toolCallInfo: params =>
      Promise.resolve({
        type: 'mcp',
        mcp_server_id: 'finder',
        mcp_server_name: 'finder',
        original_tool_name: params.name,
      }),
  };
}

export function runSentinelAuditHeldSearchContractSuite(getStore: () => ISentinelAuditStore): void {
  async function heldInfo({ query, searchWithoutAsking }: { query: string; searchWithoutAsking: boolean }) {
    const services = {
      ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      audit: getStore(),
      searchWithoutAsking: () => Promise.resolve(searchWithoutAsking),
      outboundSecrets: () => Promise.resolve([SERVER_KEY]),
    };
    const toolSet = new ToolSet({
      source: searchSource(),
      selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [], requireApprovalForTools: undefined },
      preload: true,
      sentinel: createSentinelHostContext({ ...OWNER, services }),
      searchProvider: { tools: ['lookup'] },
    });
    const info = await toolSet.toolCallInfo({ name: 'lookup', arguments: { query } });
    return { info, services };
  }

  const cases = [
    ['a server key', `debug ${SERVER_KEY}`, true],
    ['a server key with searches set to ask', `debug ${SERVER_KEY}`, false],
    ['a signed token', JWT, true],
    ['a card number', CARD_NUMBER, true],
    ['a password label', PASSWORD_LABEL, true],
    ['a search set to ask', 'oslo weather in march', false],
  ] as const;

  it.each(cases)('stores the rule, not the query, for %s', async (_label, query, searchWithoutAsking) => {
    const { info, services } = await heldInfo({ query, searchWithoutAsking });
    expect(info.tier).toBe(3);
    for (const outcome of ['logged', 'approved', 'denied'] as const) {
      await recordHeldActionAudit({ services, identity: OWNER, info, outcome, note: 'Held' });
    }
    const rows = await getStore().list({ ...OWNER, limit: 50, offset: 0 });
    expect(rows.map(row => row.outcome).sort()).toEqual(['approved', 'denied', 'logged']);
    for (const row of rows) {
      expect(row.description).toContain('Search the web through finder');
      expect(row.description).not.toContain(query);
      expect(row.description).not.toContain(SERVER_KEY);
    }
  });
}
