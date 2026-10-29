import winston from 'winston';
import { ModelCatalog } from '../../../src/catalog/ModelCatalog';
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
};

const NANO_MODEL = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';

function shippedTokenFactoryModels() {
  return (
    ModelCatalog.load()
      .list()
      .find(entry => entry.type === 'tokenfactory')?.models ?? []
  );
}

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
  it('writes the provider with only the configured model when the catalog has none', async () => {
    const { store } = await createStores();

    await expect(
      ensureEnvManagedTokenFactoryProvider({ store, tenant_id: TENANT, settings, catalogModels: [], logger }),
    ).resolves.toBe('upserted');

    const record = await store.getProvider({ tenant_id: TENANT, name: 'tokenfactory', model_name: '' });
    expect(record?.manifest).toEqual({
      type: 'tokenfactory',
      base_url: 'https://api.tokenfactory.nebius.com/v1',
      auth: { api_key: 'sk-nebius' },
      models: [{ model_id: 'nvidia/nemotron-3-super-120b-a12b', name: 'nemotron-3-super-120b-a12b', properties: {} }],
    });
    const models = await store.listModels({ tenant_id: TENANT });
    expect(models.map(model => model.name)).toEqual(['tokenfactory/nemotron-3-super-120b-a12b']);
  });

  it('offers every catalog Token Factory model, with the configured one first', async () => {
    const { store } = await createStores();

    await ensureEnvManagedTokenFactoryProvider({
      store,
      tenant_id: TENANT,
      settings: { ...settings, model: NANO_MODEL },
      catalogModels: shippedTokenFactoryModels(),
      logger,
    });

    expect((await store.listModels({ tenant_id: TENANT })).map(model => model.name)).toEqual([
      'tokenfactory/nvidia-nemotron-3-nano-30b-a3b',
      'tokenfactory/nemotron-3-super-120b-a12b',
    ]);
    const record = await store.getProvider({ tenant_id: TENANT, name: 'tokenfactory', model_name: '' });
    expect(record?.manifest.models.map(model => model.model_id)).toEqual([
      NANO_MODEL,
      'nvidia/nemotron-3-super-120b-a12b',
    ]);
    // Each model keeps the catalog's output cap, so long replies are not cut short.
    expect(record?.manifest.models[1]?.properties.max_output_tokens).toBe(32768);
  });

  it('keeps the catalog output cap on the configured model', async () => {
    const { store } = await createStores();
    await ensureEnvManagedTokenFactoryProvider({
      store,
      tenant_id: TENANT,
      settings,
      catalogModels: shippedTokenFactoryModels(),
      logger,
    });

    const record = await store.getProvider({ tenant_id: TENANT, name: 'tokenfactory', model_name: '' });
    expect(record?.manifest.models[0]?.model_id).toBe(settings.model);
    expect(record?.manifest.models[0]?.properties.max_output_tokens).toBe(32768);
  });

  it('lets a chat resolve Super when Nano is the configured model', async () => {
    const { store } = await createStores();
    await ensureEnvManagedTokenFactoryProvider({
      store,
      tenant_id: TENANT,
      settings: { ...settings, model: NANO_MODEL },
      catalogModels: shippedTokenFactoryModels(),
      logger,
    });

    const provider = await store.getProvider({
      tenant_id: TENANT,
      name: 'tokenfactory',
      model_name: 'nemotron-3-super-120b-a12b',
    });

    expect(provider?.manifest.models.find(model => model.name === 'nemotron-3-super-120b-a12b')?.model_id).toBe(
      'nvidia/nemotron-3-super-120b-a12b',
    );
  });

  it('keeps the configured model id when the catalog spells it in another case', async () => {
    const { store } = await createStores();

    await ensureEnvManagedTokenFactoryProvider({
      store,
      tenant_id: TENANT,
      settings: { ...settings, model: 'nvidia/nvidia-nemotron-3-nano-30b-a3b' },
      catalogModels: shippedTokenFactoryModels(),
      logger,
    });

    const record = await store.getProvider({ tenant_id: TENANT, name: 'tokenfactory', model_name: '' });
    expect(record?.manifest.models.map(model => model.model_id)).toEqual([
      'nvidia/nvidia-nemotron-3-nano-30b-a3b',
      'nvidia/nemotron-3-super-120b-a12b',
    ]);
  });

  it('resolves the model for a turn, which used to return 422 without a provider record', async () => {
    const { store } = await createStores();
    await ensureEnvManagedTokenFactoryProvider({ store, tenant_id: TENANT, settings, catalogModels: [], logger });

    const provider = await store.getProvider({ tenant_id: TENANT, name: 'tokenfactory', model_name: 'x' });

    expect(provider?.manifest.models.some(model => model.name === 'nemotron-3-super-120b-a12b')).toBe(true);
  });

  it('is idempotent across restarts and never duplicates the record', async () => {
    const { store } = await createStores();
    await ensureEnvManagedTokenFactoryProvider({ store, tenant_id: TENANT, settings, catalogModels: [], logger });
    const first = await store.getProvider({ tenant_id: TENANT, name: 'tokenfactory', model_name: '' });

    const outcomes = [
      await ensureEnvManagedTokenFactoryProvider({ store, tenant_id: TENANT, settings, catalogModels: [], logger }),
      await ensureEnvManagedTokenFactoryProvider({ store, tenant_id: TENANT, settings, catalogModels: [], logger }),
    ];

    expect(outcomes).toEqual(['unchanged', 'unchanged']);
    expect(await store.listProviders({ tenant_id: TENANT })).toHaveLength(1);
    const again = await store.getProvider({ tenant_id: TENANT, name: 'tokenfactory', model_name: '' });
    expect(again?.updated_at).toBe(first?.updated_at);
  });

  it('applies a rotated key and a changed model on the next boot, still as one record', async () => {
    const { store } = await createStores();
    await ensureEnvManagedTokenFactoryProvider({ store, tenant_id: TENANT, settings, catalogModels: [], logger });

    const outcome = await ensureEnvManagedTokenFactoryProvider({
      store,
      tenant_id: TENANT,
      settings: {
        ...settings,
        apiKey: 'sk-rotated',
        model: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
      },
      catalogModels: [],
      logger,
    });

    expect(outcome).toBe('upserted');
    const records = await store.listProviders({ tenant_id: TENANT });
    expect(records).toHaveLength(1);
    expect(records[0]?.manifest.auth?.api_key).toBe('sk-rotated');
    expect(records[0]?.manifest.models.map(model => model.model_id)).toEqual([
      'Qwen/Qwen3-235B-A22B-Instruct-2507',
      'nvidia/nemotron-3-super-120b-a12b',
    ]);
  });

  it('keeps a model an earlier boot registered, so a role still pointing at the old default resolves', async () => {
    const { store } = await createStores();
    await ensureEnvManagedTokenFactoryProvider({
      store,
      tenant_id: TENANT,
      settings: { ...settings, model: 'openai/gpt-oss-120b' },
      catalogModels: [],
      logger,
    });

    await ensureEnvManagedTokenFactoryProvider({ store, tenant_id: TENANT, settings, catalogModels: [], logger });

    expect((await store.listModels({ tenant_id: TENANT })).map(model => model.name)).toEqual([
      'tokenfactory/nemotron-3-super-120b-a12b',
      'tokenfactory/gpt-oss-120b',
    ]);
  });

  it('keeps a stream deadline an earlier record carried', async () => {
    const { store } = await createStores();
    await store.upsertProvider({
      tenant_id: TENANT,
      name: 'tokenfactory',
      manifest: {
        ...buildEnvManagedTokenFactoryManifest({ settings: { ...settings, apiKey: 'sk-old' }, catalogModels: [] }),
        stream_timeout: { first_chunk_ms: 90_000 },
      },
    });

    await ensureEnvManagedTokenFactoryProvider({ store, tenant_id: TENANT, settings, catalogModels: [], logger });

    const record = await store.getProvider({ tenant_id: TENANT, name: 'tokenfactory', model_name: '' });
    expect(record?.manifest.stream_timeout).toEqual({ first_chunk_ms: 90_000 });
    expect(record?.manifest.auth?.api_key).toBe('sk-nebius');
  });

  it.each([undefined, '', '   '])('does nothing without a key (%j)', async apiKey => {
    const { store } = await createStores();

    await expect(
      ensureEnvManagedTokenFactoryProvider({
        store,
        tenant_id: TENANT,
        settings: { ...settings, apiKey },
        catalogModels: [],
        logger,
      }),
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
  it('puts the configured model first in the chat picker when catalog models are listed too', async () => {
    const { store, globalSettingsStore } = await createStores();
    await ensureEnvManagedTokenFactoryProvider({
      store,
      tenant_id: TENANT,
      settings: { ...settings, model: NANO_MODEL },
      catalogModels: shippedTokenFactoryModels(),
      logger,
    });
    await seedEnvManagedDefaultChatModel({ globalSettingsStore, model: NANO_MODEL, logger });

    const defaultName = await readDefaultChatModel({ globalSettingsStore, logger });
    const listed = putDefaultModelFirst(await store.listModels({ tenant_id: TENANT }), defaultName);

    expect(defaultName).toBe('tokenfactory/nvidia-nemotron-3-nano-30b-a3b');
    expect(listed.map(model => model.name)).toEqual([
      'tokenfactory/nvidia-nemotron-3-nano-30b-a3b',
      'tokenfactory/nemotron-3-super-120b-a12b',
    ]);
  });

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
