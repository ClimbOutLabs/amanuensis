import winston from 'winston';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import {
  buildEnvManagedTokenFactoryManifest,
  DEFAULT_CHAT_MODEL_SETTING_KEY,
  ensureEnvManagedTokenFactoryProvider,
  envManagedDefaultModelName,
  envManagedModelProviderNames,
  putDefaultModelFirst,
  readDefaultChatModel,
  seedEnvManagedDefaultChatModel,
  tokenFactoryModelName,
} from '../../../src/runtime/tokenFactoryProvider';

const logger = winston.createLogger({ silent: true });
const TENANT = 'default';

const settings = {
  apiKey: 'sk-nebius',
  baseUrl: 'https://api.tokenfactory.nebius.com/v1',
  model: 'nvidia/nemotron-3-super-120b-a12b',
  cheaperModel: 'openai/gpt-oss-120b',
};

async function createStores() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  return { store: new SqliteModelProviderStore(db), globalSettingsStore: new SqliteGlobalSettingsStore(db) };
}

describe('tokenFactoryModelName', () => {
  it.each([
    ['nvidia/nemotron-3-super-120b-a12b', 'nemotron-3-super-120b-a12b'],
    ['openai/gpt-oss-120b', 'gpt-oss-120b'],
    ['Qwen/Qwen3-235B-A22B-Instruct-2507', 'qwen3-235b-a22b-instruct-2507'],
    ['meta/Llama_3.3 70B', 'llama-3-3-70b'],
    ['org/3b-model', 'm-3b-model'],
  ])('turns %s into the resource name %s', (modelId, name) => {
    expect(tokenFactoryModelName(modelId)).toBe(name);
  });
});

describe('ensureEnvManagedTokenFactoryProvider', () => {
  it('writes the provider with the default model first and the cheaper model second', async () => {
    const { store } = await createStores();

    await expect(ensureEnvManagedTokenFactoryProvider({ store, tenant_id: TENANT, settings, logger })).resolves.toBe(
      'upserted',
    );

    const record = await store.getProvider({ tenant_id: TENANT, name: 'tokenfactory', model_name: '' });
    expect(record?.manifest).toEqual({
      type: 'tokenfactory',
      base_url: 'https://api.tokenfactory.nebius.com/v1',
      auth: { api_key: 'sk-nebius' },
      models: [
        { model_id: 'nvidia/nemotron-3-super-120b-a12b', name: 'nemotron-3-super-120b-a12b', properties: {} },
        { model_id: 'openai/gpt-oss-120b', name: 'gpt-oss-120b', properties: {} },
      ],
    });
    const models = await store.listModels({ tenant_id: TENANT });
    expect(models.map(model => model.name)).toEqual([
      'tokenfactory/nemotron-3-super-120b-a12b',
      'tokenfactory/gpt-oss-120b',
    ]);
  });

  it('resolves the model for a turn, which used to return 422 without a provider record', async () => {
    const { store } = await createStores();
    await ensureEnvManagedTokenFactoryProvider({ store, tenant_id: TENANT, settings, logger });

    const provider = await store.getProvider({ tenant_id: TENANT, name: 'tokenfactory', model_name: 'x' });

    expect(provider?.manifest.models.some(model => model.name === 'nemotron-3-super-120b-a12b')).toBe(true);
  });

  it('is idempotent across restarts and never duplicates the record', async () => {
    const { store } = await createStores();
    await ensureEnvManagedTokenFactoryProvider({ store, tenant_id: TENANT, settings, logger });
    const first = await store.getProvider({ tenant_id: TENANT, name: 'tokenfactory', model_name: '' });

    const outcomes = [
      await ensureEnvManagedTokenFactoryProvider({ store, tenant_id: TENANT, settings, logger }),
      await ensureEnvManagedTokenFactoryProvider({ store, tenant_id: TENANT, settings, logger }),
    ];

    expect(outcomes).toEqual(['unchanged', 'unchanged']);
    expect(await store.listProviders({ tenant_id: TENANT })).toHaveLength(1);
    const again = await store.getProvider({ tenant_id: TENANT, name: 'tokenfactory', model_name: '' });
    expect(again?.updated_at).toBe(first?.updated_at);
  });

  it('applies a rotated key and a changed model on the next boot, still as one record', async () => {
    const { store } = await createStores();
    await ensureEnvManagedTokenFactoryProvider({ store, tenant_id: TENANT, settings, logger });

    const outcome = await ensureEnvManagedTokenFactoryProvider({
      store,
      tenant_id: TENANT,
      settings: {
        ...settings,
        apiKey: 'sk-rotated',
        model: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
        cheaperModel: undefined,
      },
      logger,
    });

    expect(outcome).toBe('upserted');
    const records = await store.listProviders({ tenant_id: TENANT });
    expect(records).toHaveLength(1);
    expect(records[0]?.manifest.auth?.api_key).toBe('sk-rotated');
    expect(records[0]?.manifest.models.map(model => model.model_id)).toEqual(['Qwen/Qwen3-235B-A22B-Instruct-2507']);
  });

  it('registers one model when the cheaper model equals the default', async () => {
    const manifest = buildEnvManagedTokenFactoryManifest({ ...settings, cheaperModel: settings.model });
    expect(manifest.models).toHaveLength(1);
  });

  it('keeps a stream deadline an earlier record carried', async () => {
    const { store } = await createStores();
    await store.upsertProvider({
      tenant_id: TENANT,
      name: 'tokenfactory',
      manifest: {
        ...buildEnvManagedTokenFactoryManifest({ ...settings, apiKey: 'sk-old' }),
        stream_timeout: { first_chunk_ms: 90_000 },
      },
    });

    await ensureEnvManagedTokenFactoryProvider({ store, tenant_id: TENANT, settings, logger });

    const record = await store.getProvider({ tenant_id: TENANT, name: 'tokenfactory', model_name: '' });
    expect(record?.manifest.stream_timeout).toEqual({ first_chunk_ms: 90_000 });
    expect(record?.manifest.auth?.api_key).toBe('sk-nebius');
  });

  it.each([undefined, '', '   '])('does nothing without a key (%j)', async apiKey => {
    const { store } = await createStores();

    await expect(
      ensureEnvManagedTokenFactoryProvider({ store, tenant_id: TENANT, settings: { ...settings, apiKey }, logger }),
    ).resolves.toBe('skipped');

    expect(await store.listProviders({ tenant_id: TENANT })).toEqual([]);
  });
});

describe('envManagedModelProviderNames', () => {
  it('names the token factory provider when a key is set', () => {
    expect([...envManagedModelProviderNames({ apiKey: 'sk', managedByTrueFoundry: false })]).toEqual(['tokenfactory']);
  });

  it.each([
    ['no key', undefined, false],
    ['a blank key', '  ', false],
    ['TrueFoundry owning the providers', 'sk', true],
  ])('names nothing with %s', (_label, apiKey, managedByTrueFoundry) => {
    expect(envManagedModelProviderNames({ apiKey, managedByTrueFoundry }).size).toBe(0);
  });
});

describe('default chat model', () => {
  it('is seeded when none is set', async () => {
    const { globalSettingsStore } = await createStores();

    await seedEnvManagedDefaultChatModel({ globalSettingsStore, model: settings.model, logger });

    expect((await globalSettingsStore.getSetting({ key: DEFAULT_CHAT_MODEL_SETTING_KEY }))?.value).toBe(
      'tokenfactory/nemotron-3-super-120b-a12b',
    );
    expect(envManagedDefaultModelName(settings.model)).toBe('tokenfactory/nemotron-3-super-120b-a12b');
  });

  it('leaves a default that points at another provider alone', async () => {
    const { globalSettingsStore } = await createStores();
    await globalSettingsStore.setSetting({ key: DEFAULT_CHAT_MODEL_SETTING_KEY, value: 'openai/gpt-5-5' });

    await seedEnvManagedDefaultChatModel({ globalSettingsStore, model: settings.model, logger });

    expect((await globalSettingsStore.getSetting({ key: DEFAULT_CHAT_MODEL_SETTING_KEY }))?.value).toBe(
      'openai/gpt-5-5',
    );
  });

  it('follows a changed TOKEN_FACTORY_MODEL when the default was the env-managed one', async () => {
    const { globalSettingsStore } = await createStores();
    await seedEnvManagedDefaultChatModel({ globalSettingsStore, model: settings.model, logger });

    await seedEnvManagedDefaultChatModel({ globalSettingsStore, model: 'openai/gpt-oss-120b', logger });

    expect((await globalSettingsStore.getSetting({ key: DEFAULT_CHAT_MODEL_SETTING_KEY }))?.value).toBe(
      'tokenfactory/gpt-oss-120b',
    );
  });

  it('reads as unset when the settings store fails', async () => {
    const { globalSettingsStore } = await createStores();
    jest.spyOn(globalSettingsStore, 'getSetting').mockRejectedValue(new Error('db down'));

    await expect(readDefaultChatModel({ globalSettingsStore, logger })).resolves.toBeUndefined();
  });
});

describe('putDefaultModelFirst', () => {
  const models = ['a/one', 'b/two', 'c/three'].map(name => ({
    name,
    model_id: name,
    provider: { name: name.slice(0, 1) },
    properties: {},
  }));

  it('moves the default to the front and keeps the others in order', () => {
    expect(putDefaultModelFirst(models, 'c/three').map(model => model.name)).toEqual(['c/three', 'a/one', 'b/two']);
  });

  it('keeps the order when there is no default or it is not listed', () => {
    expect(putDefaultModelFirst(models, undefined)).toBe(models);
    expect(putDefaultModelFirst(models, 'z/none').map(model => model.name)).toEqual(['a/one', 'b/two', 'c/three']);
  });
});
