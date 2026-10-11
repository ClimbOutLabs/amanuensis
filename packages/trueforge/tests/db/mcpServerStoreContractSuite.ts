/**
 * Backend-agnostic behavioural contract for IMcpServerStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import { McpServerNameConflictError, type IMcpServerStore } from '../../src/db/mcpServerStore';
import type { OAuthClientRecord } from '../../src/mcp/auth/types';
import type { RemoteMcpServerManifest } from '../../src/schemas/mcpServer';

const TENANT = 'default';

function manifest(overrides: Partial<RemoteMcpServerManifest> = {}): RemoteMcpServerManifest {
  return {
    type: 'remote',
    name: 'linear',
    url: 'https://mcp.linear.app/mcp',
    description: 'Linear MCP server.',
    auth: { type: 'dcr' },
    ...overrides,
  };
}

const sampleOAuthClient: OAuthClientRecord = {
  server: {
    authorizationEndpoint: 'https://auth.example.com/authorize',
    tokenEndpoint: 'https://auth.example.com/token',
    codeChallengeMethodsSupported: ['S256'],
  },
  client: {
    clientId: 'client-1',
    clientSecret: 'secret-1',
  },
};

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function runMcpServerStoreContractSuite(getStore: () => IMcpServerStore): void {
  it('upsert creates a server and round-trips the manifest', async () => {
    const store = getStore();
    const created = await store.upsertServer({
      tenant_id: TENANT,
      name: 'linear',
      manifest: manifest(),
      first_party: false,
    });

    expect(created.tenant_id).toBe(TENANT);
    expect(created.name).toBe('linear');
    expect(created.id.length).toBeGreaterThan(0);
    expect(created.manifest).toEqual(manifest());
    expect(created.created_at).toMatch(ISO_UTC);
    expect(created.updated_at).toBe(created.created_at);

    const fetched = await store.getServer({ tenant_id: TENANT, name: 'linear' });
    expect(fetched).toEqual(created);
  });

  it('createServer inserts and throws McpServerNameConflictError on name clash', async () => {
    const store = getStore();
    const created = await store.createServer({
      tenant_id: TENANT,
      name: 'linear',
      manifest: manifest(),
      first_party: false,
    });
    expect(created.name).toBe('linear');

    await expect(
      store.createServer({ tenant_id: TENANT, name: 'linear', manifest: manifest(), first_party: false }),
    ).rejects.toBeInstanceOf(McpServerNameConflictError);
  });

  it('getServer returns undefined for unknown servers', async () => {
    const store = getStore();
    expect(await store.getServer({ tenant_id: TENANT, name: 'missing' })).toBeUndefined();
  });

  it('upsert replaces the manifest, preserves id and created_at', async () => {
    const store = getStore();
    const created = await store.upsertServer({
      tenant_id: TENANT,
      name: 'linear',
      manifest: manifest(),
      first_party: false,
    });

    const replacement = manifest({
      name: 'linear',
      url: 'https://mcp.linear.app/mcp/v2',
    });
    const updated = await store.upsertServer({
      tenant_id: TENANT,
      name: 'linear',
      manifest: replacement,
      first_party: false,
    });

    expect(updated.id).toBe(created.id);
    expect(updated.manifest).toEqual(replacement);
    expect(updated.created_at).toBe(created.created_at);
    expect(Date.parse(updated.updated_at)).toBeGreaterThanOrEqual(Date.parse(created.updated_at));

    const servers = await store.listServers({
      tenant_id: TENANT,
      names: undefined,
    });
    expect(servers).toEqual([updated]);
  });

  it('listServers returns only the tenant, ordered by name', async () => {
    const store = getStore();
    await store.upsertServer({ tenant_id: TENANT, name: 'linear', manifest: manifest(), first_party: false });
    await store.upsertServer({
      tenant_id: TENANT,
      name: 'deepwiki',
      manifest: manifest({ name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' }),
      first_party: false,
    });
    await store.upsertServer({ tenant_id: 'other-tenant', name: 'linear', manifest: manifest(), first_party: false });

    const servers = await store.listServers({
      tenant_id: TENANT,
      names: undefined,
    });
    expect(servers.map(server => server.name)).toEqual(['deepwiki', 'linear']);
    expect(servers.every(server => server.tenant_id === TENANT)).toBe(true);
  });

  it('listServers filters by names and returns empty for an empty name list', async () => {
    const store = getStore();
    await store.upsertServer({ tenant_id: TENANT, name: 'linear', manifest: manifest(), first_party: false });
    await store.upsertServer({
      tenant_id: TENANT,
      name: 'deepwiki',
      manifest: manifest({ name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' }),
      first_party: false,
    });
    await store.upsertServer({
      tenant_id: TENANT,
      name: 'notion',
      manifest: manifest({ name: 'notion', url: 'https://mcp.notion.com/mcp' }),
      first_party: false,
    });

    const filtered = await store.listServers({
      tenant_id: TENANT,
      names: ['notion', 'missing', 'deepwiki'],
    });
    expect(filtered.map(server => server.name)).toEqual(['deepwiki', 'notion']);

    await expect(store.listServers({ tenant_id: TENANT, names: [] })).resolves.toEqual([]);
  });
  it('upsert leaves oauth columns null and does not clear a saved OAuth client', async () => {
    const store = getStore();
    const created = await store.upsertServer({
      tenant_id: TENANT,
      name: 'linear',
      manifest: manifest(),
      first_party: false,
    });
    expect(await store.getClient({ id: created.id })).toBeUndefined();

    await store.saveClient({ id: created.id, record: sampleOAuthClient });
    expect(await store.getClient({ id: created.id })).toEqual(sampleOAuthClient);

    await store.upsertServer({
      tenant_id: TENANT,
      name: 'linear',
      manifest: manifest({ url: 'https://mcp.linear.app/mcp/v2' }),
      first_party: false,
    });
    expect(await store.getClient({ id: created.id })).toEqual(sampleOAuthClient);
  });

  it('save/get/delete OAuth client round-trips and clears registration', async () => {
    const store = getStore();
    const created = await store.upsertServer({
      tenant_id: TENANT,
      name: 'linear',
      manifest: manifest(),
      first_party: false,
    });

    await store.saveClient({ id: created.id, record: sampleOAuthClient });
    expect(await store.getClient({ id: created.id })).toEqual(sampleOAuthClient);

    await store.deleteClient({ id: created.id });
    expect(await store.getClient({ id: created.id })).toBeUndefined();
  });

  it('getClient returns undefined for unknown server ids', async () => {
    const store = getStore();
    expect(await store.getClient({ id: 'missing-id' })).toBeUndefined();
  });

  it('deleteServer removes the row and returns true, then false on repeat', async () => {
    const store = getStore();
    await store.upsertServer({ tenant_id: TENANT, name: 'linear', manifest: manifest(), first_party: false });

    expect(await store.deleteServer({ tenant_id: TENANT, name: 'linear' })).toBe(true);
    expect(await store.getServer({ tenant_id: TENANT, name: 'linear' })).toBeUndefined();
    expect(await store.deleteServer({ tenant_id: TENANT, name: 'linear' })).toBe(false);
  });

  it('deleteServer returns false for an unknown name and leaves other tenants alone', async () => {
    const store = getStore();
    expect(await store.deleteServer({ tenant_id: TENANT, name: 'missing' })).toBe(false);

    await store.upsertServer({ tenant_id: TENANT, name: 'linear', manifest: manifest(), first_party: false });
    await store.upsertServer({ tenant_id: 'other-tenant', name: 'linear', manifest: manifest(), first_party: false });

    expect(await store.deleteServer({ tenant_id: TENANT, name: 'linear' })).toBe(true);
    expect(await store.getServer({ tenant_id: 'other-tenant', name: 'linear' })).toBeDefined();
  });

  it('stores first_party as given on create and returns it from get and list', async () => {
    const store = getStore();
    const trusted = await store.createServer({
      tenant_id: TENANT,
      name: 'memory',
      manifest: manifest({ name: 'memory', url: 'https://hindsight.example.com/mcp/aman', memory_provider: true }),
      first_party: true,
    });
    await store.createServer({
      tenant_id: TENANT,
      name: 'linear',
      manifest: manifest(),
      first_party: false,
    });

    expect(trusted.first_party).toBe(true);
    expect((await store.getServer({ tenant_id: TENANT, name: 'memory' }))?.first_party).toBe(true);
    expect((await store.getServer({ tenant_id: TENANT, name: 'linear' }))?.first_party).toBe(false);
    const listed = await store.listServers({ tenant_id: TENANT, names: undefined });
    expect(listed.map(server => [server.name, server.first_party])).toEqual([
      ['linear', false],
      ['memory', true],
    ]);
  });

  it('upsert writes first_party as given, so a write that drops trust drops it and one that grants it grants it', async () => {
    const store = getStore();
    const created = await store.upsertServer({
      tenant_id: TENANT,
      name: 'memory',
      manifest: manifest({ name: 'memory', url: 'https://hindsight.example.com/mcp/aman', memory_provider: true }),
      first_party: true,
    });
    expect(created.first_party).toBe(true);

    const dropped = await store.upsertServer({
      tenant_id: TENANT,
      name: 'memory',
      manifest: manifest({ name: 'memory', url: 'https://hindsight.example.com/mcp/other', memory_provider: true }),
      first_party: false,
    });
    expect(dropped.id).toBe(created.id);
    expect(dropped.first_party).toBe(false);
    expect((await store.getServer({ tenant_id: TENANT, name: 'memory' }))?.first_party).toBe(false);

    const regranted = await store.upsertServer({
      tenant_id: TENANT,
      name: 'memory',
      manifest: manifest({ name: 'memory', url: 'https://hindsight.example.com/mcp/other', memory_provider: true }),
      first_party: true,
    });
    expect(regranted.first_party).toBe(true);
  });
}
