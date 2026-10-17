/**
 * Backend-agnostic behavioural contract for IMcpToolGrantStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import type { IMcpToolGrantStore } from '../../src/db/mcpToolGrantStore';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const connector = { id: 'srv-notes', fingerprint: 'fp-original' };

const grant = {
  tenant_id: 'tenant-a',
  created_by: 'user-a',
  mcp_server_name: 'notes',
  tool_name: 'lookup_note',
  connector,
};

/** Inserts a grant as it was stored before connector identity was recorded. */
type SeedLegacyGrant = (key: typeof grant) => Promise<void>;

export function runMcpToolGrantStoreContractSuite(
  getStore: () => IMcpToolGrantStore,
  seedLegacyGrant: SeedLegacyGrant,
): void {
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

  it('no longer applies once the connector was repointed or re-credentialed, or is another connector', async () => {
    const store = getStore();
    await store.recordToolGrant(grant);

    const changed = { ...grant, connector: { ...connector, fingerprint: 'fp-changed' } };
    expect(await store.hasToolGrant(changed)).toBe(false);
    expect(await store.hasToolGrant({ ...grant, connector: { ...connector, id: 'srv-other' } })).toBe(false);
    expect(await store.listToolGrants(changed)).toEqual([]);
    expect(await store.hasToolGrant(grant)).toBe(true);
    expect((await store.listToolGrants(grant)).map(row => row.tool_name)).toEqual(['lookup_note']);
  });

  it('choosing Always allow again under a changed connector replaces the old grant', async () => {
    const store = getStore();
    await store.recordToolGrant(grant);
    const changed = { ...grant, connector: { ...connector, fingerprint: 'fp-changed' } };

    await store.recordToolGrant(changed);

    expect(await store.hasToolGrant(changed)).toBe(true);
    expect(await store.hasToolGrant(grant)).toBe(false);
    expect(await store.listToolGrants(changed)).toHaveLength(1);
  });

  it('keeps a grant from before connector identity was recorded, tied to the connector that first uses it', async () => {
    const store = getStore();
    await seedLegacyGrant(grant);

    expect((await store.listToolGrants(grant)).map(row => row.tool_name)).toEqual(['lookup_note']);
    expect(await store.hasToolGrant(grant)).toBe(true);

    const changed = { ...grant, connector: { ...connector, fingerprint: 'fp-changed' } };
    expect(await store.hasToolGrant(changed)).toBe(false);
    expect(await store.listToolGrants(changed)).toEqual([]);
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
