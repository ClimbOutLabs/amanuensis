import winston from 'winston';
import { TENANT_ID } from '../../../../src/apis/sessions';
import { STANDALONE_REQUEST_CONTEXT } from '../../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteOAuthTokenStore } from '../../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import {
  findMemoryProviderSettings,
  parseMemoryProviderUrl,
  resolveMemoryProvider,
} from '../../../../src/runtime/memory/memoryProvider';

describe('parseMemoryProviderUrl', () => {
  it('accepts a single-bank Hindsight MCP URL with a trailing slash', () => {
    expect(parseMemoryProviderUrl('https://hindsight.example.com/mcp/aman/')).toEqual({
      apiBase: 'https://hindsight.example.com',
      bank: 'aman',
    });
  });

  it('accepts a single-bank Hindsight MCP URL without a trailing slash', () => {
    expect(parseMemoryProviderUrl('http://localhost:8080/mcp/aman')).toEqual({
      apiBase: 'http://localhost:8080',
      bank: 'aman',
    });
  });

  it('rejects a URL with no bank segment', () => {
    expect(parseMemoryProviderUrl('https://hindsight.example.com/mcp/')).toBeUndefined();
  });

  it('rejects a URL that is not a /mcp/{bank}/ path', () => {
    expect(parseMemoryProviderUrl('https://hindsight.example.com/sse')).toBeUndefined();
  });

  it('rejects a bank segment containing a slash', () => {
    expect(parseMemoryProviderUrl('https://hindsight.example.com/mcp/aman/extra/')).toBeUndefined();
  });

  it('rejects a non-http(s) scheme', () => {
    expect(parseMemoryProviderUrl('ftp://hindsight.example.com/mcp/aman/')).toBeUndefined();
  });
});

describe('resolveMemoryProvider', () => {
  let db: ReturnType<typeof createSqliteDb>;
  let mcpServerStore: SqliteMcpServerStore;
  let tokenStore: SqliteOAuthTokenStore;
  let logger: ReturnType<typeof winston.createLogger>;

  beforeAll(async () => {
    db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    mcpServerStore = new SqliteMcpServerStore(db);
    tokenStore = new SqliteOAuthTokenStore(db);
  });

  beforeEach(() => {
    logger = winston.createLogger({ silent: true });
  });

  /** Isolated store for a test whose fixtures must not accumulate with the ones above. */
  async function freshStores(): Promise<{ mcpServerStore: SqliteMcpServerStore; tokenStore: SqliteOAuthTokenStore }> {
    const isolatedDb = createSqliteDb(':memory:');
    await migrateSqliteToLatest(isolatedDb);
    return { mcpServerStore: new SqliteMcpServerStore(isolatedDb), tokenStore: new SqliteOAuthTokenStore(isolatedDb) };
  }

  it('returns undefined when no server is marked as the memory provider', async () => {
    await mcpServerStore.upsertServer({
      tenant_id: TENANT_ID,
      name: 'not-memory',
      manifest: {
        type: 'remote',
        name: 'not-memory',
        url: 'https://hindsight.example.com/mcp/aman/',
        description: 'Not a memory provider.',
      },
    });

    const connection = await resolveMemoryProvider({
      mcpServerStore,
      tokenStore,
      tenantId: TENANT_ID,
      clientName: 'test-client',
      userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
      logger,
    });
    expect(connection).toBeUndefined();
  });

  it('discovers the designated memory provider and resolves its connection details', async () => {
    await mcpServerStore.upsertServer({
      tenant_id: TENANT_ID,
      name: 'hindsight',
      manifest: {
        type: 'remote',
        name: 'hindsight',
        url: 'https://hindsight.example.com/mcp/aman/',
        description: 'Hindsight memory provider.',
        auth: { type: 'header', headers: { Authorization: 'Bearer secret-token' } },
        memory_provider: true,
        memory_settings: { recall_timeout_ms: 6000, reflect_enabled: false },
      },
    });

    const connection = await resolveMemoryProvider({
      mcpServerStore,
      tokenStore,
      tenantId: TENANT_ID,
      clientName: 'test-client',
      userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
      logger,
    });

    expect(connection).toBeDefined();
    if (connection === undefined) {
      throw new Error('expected connection');
    }
    expect(connection.serverName).toBe('hindsight');
    expect(connection.apiBase).toBe('https://hindsight.example.com');
    expect(connection.bank).toBe('aman');
    expect(connection.headers).toEqual({ Authorization: 'Bearer secret-token' });
    expect(connection.settings).toEqual({ recall_timeout_ms: 6000, reflect_enabled: false });
  });

  it('picks deterministically by name and warns when more than one server is flagged', async () => {
    // Isolated store: legacy rows/races can leave more than one server flagged, and this test
    // must not depend on the order servers were created/listed in relative to the tests above.
    const { mcpServerStore: isolatedMcpServerStore, tokenStore: isolatedTokenStore } = await freshStores();

    // Inserted zebra before apple so a naive "first in listing order" pick would be wrong.
    await isolatedMcpServerStore.upsertServer({
      tenant_id: TENANT_ID,
      name: 'zebra-memory',
      manifest: {
        type: 'remote',
        name: 'zebra-memory',
        url: 'https://hindsight.example.com/mcp/zebra/',
        description: 'Second flagged memory provider (legacy row).',
        memory_provider: true,
      },
    });
    await isolatedMcpServerStore.upsertServer({
      tenant_id: TENANT_ID,
      name: 'apple-memory',
      manifest: {
        type: 'remote',
        name: 'apple-memory',
        url: 'https://hindsight.example.com/mcp/apple/',
        description: 'First flagged memory provider alphabetically (legacy row).',
        memory_provider: true,
      },
    });
    const warn = jest.spyOn(logger, 'warn');

    const connection = await resolveMemoryProvider({
      mcpServerStore: isolatedMcpServerStore,
      tokenStore: isolatedTokenStore,
      tenantId: TENANT_ID,
      clientName: 'test-client',
      userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
      logger,
    });

    expect(connection).toBeDefined();
    // Deterministic: alphabetically first name wins regardless of insertion/listing order.
    expect(connection?.serverName).toBe('apple-memory');
    expect(connection?.bank).toBe('apple');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/multiple.*memory provider/i),
      expect.objectContaining({ serverNames: ['apple-memory', 'zebra-memory'] }),
    );
  });

  it('returns undefined and logs a warning when the memory provider URL is invalid', async () => {
    // Isolated store: only one flagged server here, so the single warning under test (invalid
    // URL) is not joined by the separate multiple-flagged-servers warning covered above.
    const { mcpServerStore: isolatedMcpServerStore, tokenStore: isolatedTokenStore } = await freshStores();
    await isolatedMcpServerStore.upsertServer({
      tenant_id: TENANT_ID,
      name: 'bad-hindsight',
      manifest: {
        type: 'remote',
        name: 'bad-hindsight',
        url: 'https://hindsight.example.com/sse',
        description: 'Misconfigured memory provider.',
        memory_provider: true,
      },
    });
    const warn = jest.spyOn(logger, 'warn');

    const connection = await resolveMemoryProvider({
      mcpServerStore: isolatedMcpServerStore,
      tokenStore: isolatedTokenStore,
      tenantId: TENANT_ID,
      clientName: 'test-client',
      userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
      logger,
    });

    expect(connection).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('findMemoryProviderSettings', () => {
  async function freshStore(): Promise<SqliteMcpServerStore> {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    return new SqliteMcpServerStore(db);
  }

  it('returns undefined when no server is flagged as the memory provider', async () => {
    const mcpServerStore = await freshStore();
    const settings = await findMemoryProviderSettings({ mcpServerStore, tenantId: TENANT_ID });
    expect(settings).toBeUndefined();
  });

  it('returns the flagged server settings without resolving a connection', async () => {
    const mcpServerStore = await freshStore();
    await mcpServerStore.upsertServer({
      tenant_id: TENANT_ID,
      name: 'hindsight',
      manifest: {
        type: 'remote',
        name: 'hindsight',
        url: 'https://hindsight.example.com/mcp/aman/',
        description: 'Hindsight memory provider.',
        memory_provider: true,
        memory_settings: { screen_enabled: true, recall_timeout_ms: 6000 },
      },
    });

    const settings = await findMemoryProviderSettings({ mcpServerStore, tenantId: TENANT_ID });
    expect(settings).toEqual({ screen_enabled: true, recall_timeout_ms: 6000 });
  });

  it('returns undefined when the flagged server carries no settings', async () => {
    const mcpServerStore = await freshStore();
    await mcpServerStore.upsertServer({
      tenant_id: TENANT_ID,
      name: 'hindsight',
      manifest: {
        type: 'remote',
        name: 'hindsight',
        url: 'https://hindsight.example.com/mcp/aman/',
        description: 'Hindsight memory provider.',
        memory_provider: true,
      },
    });

    const settings = await findMemoryProviderSettings({ mcpServerStore, tenantId: TENANT_ID });
    expect(settings).toBeUndefined();
  });
});
