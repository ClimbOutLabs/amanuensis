import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { chatPrivacy, urlStaysOnThisMachine, type ResolveHostAddresses } from '../../../src/runtime/chatPrivacy';

const neverResolves: ResolveHostAddresses = () => Promise.reject(new Error('no lookup expected'));

function resolvesTo(addresses: string[]): ResolveHostAddresses {
  return () => Promise.resolve(addresses);
}

async function providerStore(
  providers: Record<string, { type: 'anthropic' | 'openai'; base_url: string }>,
): Promise<SqliteModelProviderStore> {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const store = new SqliteModelProviderStore(db);
  for (const [name, provider] of Object.entries(providers)) {
    await store.upsertProvider({
      tenant_id: 'default',
      name,
      manifest: {
        ...provider,
        auth: { api_key: 'invented-key' },
        models: ['claude-sonnet-4-6', 'claude-haiku-4-5', 'llama3'].map(model => ({
          model_id: model,
          name: model,
          properties: { context_length: 8192, max_output_tokens: 1024 },
        })),
      },
    });
  }
  return store;
}

describe('urlStaysOnThisMachine', () => {
  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:8000/v1',
    'http://127.8.9.10/v1',
    'http://[::1]:11434/v1',
    'http://host.docker.internal:11434/v1',
    'http://LOCALHOST/v1',
  ])('counts %s as this machine', async baseUrl => {
    expect(await urlStaysOnThisMachine({ baseUrl, resolveAddresses: neverResolves })).toBe(true);
  });

  it.each(['https://api.anthropic.com/v1', 'http://192.168.1.20:11434/v1', 'http://10.0.0.5/v1', 'not a url'])(
    'counts %s as elsewhere',
    async baseUrl => {
      expect(await urlStaysOnThisMachine({ baseUrl, resolveAddresses: resolvesTo(['203.0.113.7']) })).toBe(false);
    },
  );

  it('counts a name that resolves only to loopback as this machine', async () => {
    expect(
      await urlStaysOnThisMachine({ baseUrl: 'http://ollama.local/v1', resolveAddresses: resolvesTo(['127.0.0.1']) }),
    ).toBe(true);
  });

  it('counts a name with any address off this machine, or none, as elsewhere', async () => {
    const baseUrl = 'http://models.example/v1';
    expect(await urlStaysOnThisMachine({ baseUrl, resolveAddresses: resolvesTo(['127.0.0.1', '192.168.1.4']) })).toBe(
      false,
    );
    expect(await urlStaysOnThisMachine({ baseUrl, resolveAddresses: resolvesTo([]) })).toBe(false);
    expect(
      await urlStaysOnThisMachine({ baseUrl, resolveAddresses: () => Promise.reject(new Error('lookup failed')) }),
    ).toBe(false);
  });
});

describe('chatPrivacy', () => {
  let store: SqliteModelProviderStore;

  beforeEach(async () => {
    store = await providerStore({
      anthropic: { type: 'anthropic', base_url: 'https://api.anthropic.com/v1' },
      ollama: { type: 'openai', base_url: 'http://localhost:11434/v1' },
    });
  });

  it('stays on the machine when every model is local', async () => {
    expect(
      await chatPrivacy({
        tenantId: 'default',
        modelNames: ['ollama/llama3', 'ollama/llama3'],
        tokenFactoryMayAnswer: false,
        modelProviderStore: store,
        resolveAddresses: neverResolves,
      }),
    ).toEqual({ leaves_machine: false, hosted_providers: [] });
  });

  it('names each hosted provider once', async () => {
    expect(
      await chatPrivacy({
        tenantId: 'default',
        modelNames: ['ollama/llama3', 'anthropic/claude-sonnet-4-6', 'anthropic/claude-haiku-4-5'],
        tokenFactoryMayAnswer: false,
        modelProviderStore: store,
        resolveAddresses: neverResolves,
      }),
    ).toEqual({ leaves_machine: true, hosted_providers: [{ type: 'anthropic', name: 'anthropic' }] });
  });

  it('counts Token Factory, and a model with no configured provider, as hosted', async () => {
    expect(
      await chatPrivacy({
        tenantId: 'default',
        modelNames: ['ollama/llama3', 'missing/model'],
        tokenFactoryMayAnswer: true,
        modelProviderStore: store,
        resolveAddresses: neverResolves,
      }),
    ).toEqual({
      leaves_machine: true,
      hosted_providers: [
        { type: 'tokenfactory', name: 'tokenfactory' },
        { type: 'custom', name: 'missing' },
      ],
    });
  });
});
