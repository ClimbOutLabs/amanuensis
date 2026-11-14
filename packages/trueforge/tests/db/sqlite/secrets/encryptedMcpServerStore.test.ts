import { sql } from 'kysely';

import { SqliteMcpServerStore } from '../../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import type { OAuthClientRecord } from '../../../../src/mcp/auth/types';
import type { McpServerManifest } from '../../../../src/schemas/mcpServer';
import { EncryptedMcpServerStore } from '../../../../src/secrets/encryptedMcpServerStore';
import { SecretDecryptError } from '../../../../src/secrets/secretCipher';
import { SecretsLockedError, type SecretVault } from '../../../../src/secrets/secretVault';
import { runMcpServerStoreContractSuite } from '../../mcpServerStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';
import { createLockedVault, createUnlockedVault, databaseFilesContain } from './testVault';

const HEADER_CANARY = 'ha-canary-91c0de77aa';
const CLIENT_CANARY = 'cs-canary-3f6b20e1d4';
const DCR_CANARY = 'dcr-canary-8a44b1c9f2';
const TENANT = 'default';

const headerServer: McpServerManifest = {
  type: 'remote',
  name: 'home',
  url: 'https://home.example.com/mcp',
  description: 'Home server.',
  auth: { type: 'header', headers: { Authorization: `Bearer ${HEADER_CANARY}`, 'X-Extra': HEADER_CANARY } },
};
const clientServer: McpServerManifest = {
  type: 'remote',
  name: 'docs',
  url: 'https://docs.example.com/mcp',
  description: 'Docs server.',
  auth: { type: 'oauth_client', client_id: 'client-1', client_secret: CLIENT_CANARY },
};
const registeredClient: OAuthClientRecord = {
  server: {
    authorizationEndpoint: 'https://auth.example.com/authorize',
    tokenEndpoint: 'https://auth.example.com/token',
    codeChallengeMethodsSupported: ['S256'],
  },
  client: { clientId: 'client-1', clientSecret: DCR_CANARY },
};

describe('EncryptedMcpServerStore on SQLite', () => {
  let env: SqliteTestDatabase;
  let inner: SqliteMcpServerStore;
  let vault: SecretVault;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    inner = new SqliteMcpServerStore(env.db);
    vault = await createUnlockedVault(env.db);
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runMcpServerStoreContractSuite(() => new EncryptedMcpServerStore({ store: inner, vault }));

  it('round-trips header values and client secrets without writing them to the database files', async () => {
    const store = new EncryptedMcpServerStore({ store: inner, vault });
    const home = await store.createServer({
      tenant_id: TENANT,
      name: 'home',
      manifest: headerServer,
      first_party: false,
    });
    await store.upsertServer({ tenant_id: TENANT, name: 'docs', manifest: clientServer, first_party: false });
    await store.saveClient({ id: home.id, record: registeredClient });

    expect((await store.getServer({ tenant_id: TENANT, name: 'home' }))?.manifest).toEqual(headerServer);
    expect((await store.getServer({ tenant_id: TENANT, name: 'docs' }))?.manifest).toEqual(clientServer);
    expect(await store.getClient({ id: home.id })).toEqual(registeredClient);

    await sql`PRAGMA wal_checkpoint(TRUNCATE)`.execute(env.db);
    for (const needle of [HEADER_CANARY, CLIENT_CANARY, DCR_CANARY]) {
      expect(await databaseFilesContain({ databaseFile: env.databaseFile, needle })).toBe(false);
    }
  });

  it('refuses a header value moved to another header name', async () => {
    const store = new EncryptedMcpServerStore({ store: inner, vault });
    await store.createServer({ tenant_id: TENANT, name: 'home', manifest: headerServer, first_party: false });
    const raw = await inner.getServer({ tenant_id: TENANT, name: 'home' });
    if (raw?.manifest.auth?.type !== 'header') {
      throw new Error('header server missing');
    }
    const swapped = { Authorization: raw.manifest.auth.headers['X-Extra'] ?? '', 'X-Extra': 'plain' };
    await inner.upsertServer({
      tenant_id: TENANT,
      name: 'home',
      manifest: { ...raw.manifest, auth: { type: 'header', headers: swapped } },
      first_party: false,
    });
    await expect(store.getServer({ tenant_id: TENANT, name: 'home' })).rejects.toThrow(SecretDecryptError);
  });

  it('reads values saved before encryption', async () => {
    const home = await inner.createServer({
      tenant_id: TENANT,
      name: 'home',
      manifest: headerServer,
      first_party: false,
    });
    await inner.saveClient({ id: home.id, record: registeredClient });
    const store = new EncryptedMcpServerStore({ store: inner, vault });
    expect((await store.getServer({ tenant_id: TENANT, name: 'home' }))?.manifest).toEqual(headerServer);
    expect(await store.getClient({ id: home.id })).toEqual(registeredClient);
  });

  it('while locked: saves nothing and reads no secret', async () => {
    await new EncryptedMcpServerStore({ store: inner, vault }).createServer({
      tenant_id: TENANT,
      name: 'home',
      manifest: headerServer,
      first_party: false,
    });
    const store = new EncryptedMcpServerStore({ store: inner, vault: await createLockedVault(env.db) });
    await expect(store.listServers({ tenant_id: TENANT, names: undefined })).rejects.toThrow(SecretsLockedError);
    await expect(
      store.upsertServer({ tenant_id: TENANT, name: 'docs', manifest: clientServer, first_party: false }),
    ).rejects.toThrow(SecretsLockedError);
    expect(await inner.listServers({ tenant_id: TENANT, names: undefined })).toHaveLength(1);
  });
});
