/**
 * Backend-agnostic behavioural contract for IMcpToolGrantStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import type { IMcpToolGrantStore } from '../../src/db/mcpToolGrantStore';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const grant = {
  tenant_id: 'tenant-a',
  created_by: 'user-a',
  mcp_server_name: 'notes',
  tool_name: 'lookup_note',
};

export function runMcpToolGrantStoreContractSuite(getStore: () => IMcpToolGrantStore): void {
  it('reports no grant until one is recorded', async () => {
    const store = getStore();
    expect(await store.hasToolGrant(grant)).toBe(false);

    await store.recordToolGrant(grant);

    expect(await store.hasToolGrant(grant)).toBe(true);
  });

  it('recording the same grant twice keeps one row', async () => {
    const store = getStore();
    await store.recordToolGrant(grant);
    await store.recordToolGrant(grant);

    const listed = await store.listToolGrants(grant);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.tool_name).toBe('lookup_note');
    expect(listed[0]?.created_at).toMatch(ISO_UTC);
  });

  it('never lets a grant cross tools, connectors, users, or tenants', async () => {
    const store = getStore();
    await store.recordToolGrant(grant);

    expect(await store.hasToolGrant({ ...grant, tool_name: 'lookup_other' })).toBe(false);
    expect(await store.hasToolGrant({ ...grant, mcp_server_name: 'tracker' })).toBe(false);
    expect(await store.hasToolGrant({ ...grant, created_by: 'user-b' })).toBe(false);
    expect(await store.hasToolGrant({ ...grant, tenant_id: 'tenant-b' })).toBe(false);
    expect(await store.listToolGrants({ ...grant, created_by: 'user-b' })).toEqual([]);
  });

  it('revoking one grant leaves the other grants of that user in place', async () => {
    const store = getStore();
    await store.recordToolGrant(grant);
    await store.recordToolGrant({ ...grant, tool_name: 'list_notes' });

    await store.revokeToolGrant(grant);

    expect(await store.hasToolGrant(grant)).toBe(false);
    expect((await store.listToolGrants(grant)).map(row => row.tool_name)).toEqual(['list_notes']);
    await expect(store.revokeToolGrant(grant)).resolves.toBeUndefined();
  });

  it('revoking the grants of a connector removes them for every user and only for that connector', async () => {
    const store = getStore();
    await store.recordToolGrant(grant);
    await store.recordToolGrant({ ...grant, created_by: 'user-b' });
    await store.recordToolGrant({ ...grant, mcp_server_name: 'tracker' });

    await store.revokeServerToolGrants({ tenant_id: grant.tenant_id, mcp_server_name: grant.mcp_server_name });

    expect(await store.hasToolGrant(grant)).toBe(false);
    expect(await store.hasToolGrant({ ...grant, created_by: 'user-b' })).toBe(false);
    expect(await store.hasToolGrant({ ...grant, mcp_server_name: 'tracker' })).toBe(true);
  });
}
