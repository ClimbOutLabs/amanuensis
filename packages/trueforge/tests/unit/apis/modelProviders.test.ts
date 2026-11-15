import winston from 'winston';
import { createCatalogRouter } from '../../../src/apis/catalog';
import { createModelsRouter } from '../../../src/apis/models';
import { createSettingsRouter } from '../../../src/apis/settings';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { McpCatalog } from '../../../src/catalog/McpCatalog';
import { ModelCatalog } from '../../../src/catalog/ModelCatalog';
import { SandboxCatalog } from '../../../src/catalog/SandboxCatalog';
import { SkillCatalog } from '../../../src/catalog/SkillCatalog';
import configuration from '../../../src/config';
import { McpServerWithAuthStore } from '../../../src/db/McpServerWithAuthStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import type { IModelProviderStore } from '../../../src/db/modelProviderStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteMcpToolGrantStore } from '../../../src/db/sqlite/mcp-tool-grant-store/SqliteMcpToolGrantStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqlitePersonalizationStore } from '../../../src/db/sqlite/personalization-store/SqlitePersonalizationStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import type { CheckSavedModelProvider } from '../../../src/runtime/modelProviderCheck';
import { configureRemoteAddressCheck, type ResolveAddresses } from '../../../src/runtime/remoteAddress';
import { RequestErrorResponseSchema } from '../../../src/schemas/errors';
import {
  ListAvailableModelsResponseSchema,
  ListModelProvidersResponseSchema,
  type ModelProviderCheck,
} from '../../../src/schemas/modelProvider';
import { SECRET_REDACTION } from '../../../src/utils/secretRedaction';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

const model = {
  model_id: 'claude-sonnet-4-6',
  name: 'claude-sonnet-4-6',
  properties: { context_length: 200000, max_output_tokens: 32768, reasoning_efforts: ['low', 'high'] },
};

const anthropicBody = {
  type: 'anthropic' as const,
  auth: { api_key: 'sk-ant-secret' },
  models: [model],
};

/** What the body above is stored as: no name of its own, endpoint from its schema. */
const anthropicProvider = { ...anthropicBody, base_url: 'https://api.anthropic.com/v1' };

/** Wire view of anthropicProvider (secrets redacted). */
const anthropicProviderWire = {
  ...anthropicProvider,
  auth: { api_key: SECRET_REDACTION },
};

const customBody = {
  type: 'custom' as const,
  name: 'internal',
  base_url: 'https://llm.internal.example.com/v1',
  auth: { api_key: 'sk-custom' },
  models: [model],
};

const customBodyWire = {
  ...customBody,
  auth: { api_key: SECRET_REDACTION },
};

function wrapManifest(manifest: unknown) {
  return { manifest };
}

function configured(name: string, manifest: unknown) {
  return { name, manifest };
}

function putInit(manifest: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(wrapManifest(manifest)),
  };
}

function postInit(manifest: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(wrapManifest(manifest)),
  };
}

function withRedactedApiKey<T extends { auth: { api_key: string } }>(provider: T): T {
  return {
    ...provider,
    auth: { api_key: SECRET_REDACTION },
  };
}

/** Name lookups answer from a fixed table, so no test depends on the DNS of the machine running it. */
function fixedLookups(table: Record<string, string[]>): ResolveAddresses {
  return hostname => Promise.resolve(table[hostname] ?? []);
}

async function createRouters(
  options: {
    envManagedNames?: ReadonlySet<string>;
    resolveHostAddresses?: ResolveAddresses;
    checkSavedProvider?: CheckSavedModelProvider;
  } = {},
): Promise<{
  settingsRouter: ReturnType<typeof createSettingsRouter>;
  catalogRouter: ReturnType<typeof createCatalogRouter>;
  modelsRouter: ReturnType<typeof createModelsRouter>;
  modelProviderStore: IModelProviderStore;
  globalSettingsStore: SqliteGlobalSettingsStore;
}> {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const modelProviderStore = new SqliteModelProviderStore(db);
  const tokenStore = new SqliteOAuthTokenStore(db);
  const globalSettingsStore = new SqliteGlobalSettingsStore(db);
  return {
    settingsRouter: createSettingsRouter({
      mcpCatalog: McpCatalog.loadShipped(),
      skillCatalog: { list: () => [] },
      resolveModelProviderStore: () => modelProviderStore,
      resolveMcpServerStore: () =>
        new McpServerWithAuthStore({
          store: new SqliteMcpServerStore(db),
          tokenStore,
          clientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME,
        }),
      tokenStore,
      toolGrantStore: new SqliteMcpToolGrantStore(db),
      resolveSkillStore: () => new SqliteSkillStore(db),
      resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
      globalSettingsStore,
      personalizationStore: new SqlitePersonalizationStore(db),
      tokenFactoryBudget: uncappedTokenFactoryBudget,
      memoryTidy: { tidyNow: () => undefined, tidyState: () => ({ status: 'idle' }) },
      envManagedModelProviderNames: options.envManagedNames ?? new Set(),
      resolveHostAddresses: options.resolveHostAddresses ?? fixedLookups({}),
      // Saves in these suites carry no check outcome unless a suite wires its own checker.
      checkSavedProvider:
        options.checkSavedProvider ??
        (async () => {
          throw new Error('connection check not wired in this test');
        }),
      withTransaction: callback => db.transaction().execute(callback),
      logger: winston.createLogger({ silent: true }),
      resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
    }),
    catalogRouter: createCatalogRouter({
      modelCatalog: ModelCatalog.load(),
      mcpCatalog: McpCatalog.loadShipped(),
      skillCatalog: SkillCatalog.load(),
      sandboxCatalog: SandboxCatalog.load(),
    }),
    modelsRouter: createModelsRouter({
      resolveModelProviderStore: () => modelProviderStore,
      withTransaction: callback => db.transaction().execute(callback),
      resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
      globalSettingsStore,
      logger: winston.createLogger({ silent: true }),
    }),
    modelProviderStore,
    globalSettingsStore,
  };
}

describe('settings model-providers and models routers', () => {
  let settingsRouter: ReturnType<typeof createSettingsRouter>;
  let catalogRouter: ReturnType<typeof createCatalogRouter>;
  let modelsRouter: ReturnType<typeof createModelsRouter>;

  beforeAll(async () => {
    ({ settingsRouter, catalogRouter, modelsRouter } = await createRouters());
  });

  it('GET /catalogs/model-providers returns shipped presets plus a custom sentinel', async () => {
    const response = await catalogRouter.request('/model-providers');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { type: string; supported_reasoning_efforts?: string[] }[];
    };
    const shipped = ModelCatalog.load().list();
    expect(body.data.slice(0, -1)).toEqual([...shipped]);
    expect(body.data.at(-1)).toEqual({
      type: 'custom',
      supported_reasoning_efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    });
  });

  it('PUT upserts a well-known provider without base_url and returns redacted auth', async () => {
    const response = await settingsRouter.request('/model-providers', putInit(anthropicBody));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: configured('anthropic', anthropicProviderWire) });

    const list = await settingsRouter.request('/model-providers');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ data: [configured('anthropic', anthropicProviderWire)] });
  });

  it('POST creates a provider and returns 409 on name clash', async () => {
    const { settingsRouter: fresh } = await createRouters();
    const created = await fresh.request('/model-providers', postInit(anthropicBody));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ data: configured('anthropic', anthropicProviderWire) });

    const clash = await fresh.request('/model-providers', postInit(anthropicBody));
    expect(clash.status).toBe(409);
    expect(await clash.json()).toEqual({
      error: { message: 'Model provider name already exists: anthropic' },
    });
  });

  it('PUT requires base_url for custom providers', async () => {
    const { base_url: _, ...withoutBaseUrl } = customBody;
    const missingBaseUrl = await settingsRouter.request('/model-providers', putInit(withoutBaseUrl));
    expect(missingBaseUrl.status).toBe(400);

    const created = await settingsRouter.request('/model-providers', putInit(customBody));
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ data: configured('internal', customBodyWire) });
  });

  it('PUT rejects invalid bodies at the Zod layer', async () => {
    const badName = await settingsRouter.request('/model-providers', putInit({ ...customBody, name: 'Not A Name' }));
    expect(badName.status).toBe(400);
  });

  it('GET /models returns the FQN read view with provider.name', async () => {
    const response = await modelsRouter.request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        {
          name: 'anthropic/claude-sonnet-4-6',
          model_id: 'claude-sonnet-4-6',
          provider: { name: 'anthropic' },
          properties: model.properties,
        },
        {
          name: 'internal/claude-sonnet-4-6',
          model_id: 'claude-sonnet-4-6',
          provider: { name: 'internal' },
          properties: model.properties,
        },
      ],
    });
  });
});

describe('custom providers may omit auth', () => {
  const originalLocalModelEndpoints = configuration.LOCAL_MODEL_ENDPOINTS;

  beforeEach(() => {
    // These providers live at the Ollama address on this computer; the operator names that
    // exact endpoint, as the local model endpoint list requires, so the saves below are
    // judged on their auth alone.
    configuration.LOCAL_MODEL_ENDPOINTS = ['localhost:11434'];
  });

  afterEach(() => {
    configuration.LOCAL_MODEL_ENDPOINTS = originalLocalModelEndpoints;
  });

  const model = {
    model_id: 'llama',
    name: 'llama',
    properties: { reasoning_efforts: ['minimal', 'low'] },
  };

  it.each([
    { label: 'auth omitted', auth: undefined, name: 'llama-no-key' },
    {
      label: 'auth set api_key',
      auth: { api_key: 'qwerty' },
      name: 'llama-with-key',
    },
  ])('PUT stores and lists custom provider with $label', async ({ auth, name }) => {
    const { settingsRouter } = await createRouters();
    const base = {
      type: 'custom' as const,
      name,
      base_url: 'http://localhost:11434/v1',
      models: [model],
    };
    const body = auth === undefined ? base : { ...base, auth };
    const expectedWire = auth === undefined ? body : withRedactedApiKey({ ...base, auth });

    const put = await settingsRouter.request('/model-providers', putInit(body));
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ data: configured(name, expectedWire) });

    const list = await settingsRouter.request('/model-providers');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ data: [configured(name, expectedWire)] });
  });

  it('rejects empty api_key', async () => {
    const { settingsRouter } = await createRouters();
    const put = await settingsRouter.request(
      '/model-providers',
      putInit({
        type: 'custom',
        name: 'llama-empty-key',
        base_url: 'http://localhost:11434/v1',
        auth: { api_key: '' },
        models: [model],
      }),
    );
    expect(put.status).toBe(400);
  });

  it('rejects auth without api_key', async () => {
    const { settingsRouter } = await createRouters();
    const put = await settingsRouter.request(
      '/model-providers',
      putInit({
        type: 'custom',
        name: 'llama-empty-auth',
        base_url: 'http://localhost:11434/v1',
        auth: {},
        models: [model],
      }),
    );
    expect(put.status).toBe(400);
  });
});

describe('well-known types are limited to one provider', () => {
  it('PUT replaces the configured provider instead of adding a second of the type', async () => {
    const { settingsRouter, modelsRouter } = await createRouters();
    expect((await settingsRouter.request('/model-providers', putInit(anthropicBody))).status).toBe(200);

    const rotated = { ...anthropicBody, auth: { api_key: 'sk-ant-rotated' } };
    const update = await settingsRouter.request('/model-providers', putInit(rotated));
    expect(update.status).toBe(200);
    expect(await update.json()).toEqual({
      data: configured('anthropic', withRedactedApiKey({ ...anthropicProvider, auth: rotated.auth })),
    });

    const list = await settingsRouter.request('/model-providers');
    expect(await list.json()).toEqual({
      data: [configured('anthropic', withRedactedApiKey({ ...anthropicProvider, auth: rotated.auth }))],
    });
    const models = await modelsRouter.request('/');
    expect(((await models.json()) as { data: { name: string }[] }).data.map(entry => entry.name)).toEqual([
      'anthropic/claude-sonnet-4-6',
    ]);
  });

  it('PUT takes no name for a well-known type, not even its own', async () => {
    const { settingsRouter } = await createRouters();
    const sibling = await settingsRouter.request(
      '/model-providers',
      putInit({ ...anthropicBody, name: 'anthropic-eu' }),
    );
    expect(sibling.status).toBe(400);
    const echoed = await settingsRouter.request('/model-providers', putInit({ ...anthropicBody, name: 'anthropic' }));
    expect(echoed.status).toBe(400);

    const list = await settingsRouter.request('/model-providers');
    expect(await list.json()).toEqual({ data: [] });
  });

  it('PUT keeps a caller-supplied base_url over the schema default', async () => {
    const { settingsRouter } = await createRouters();
    const proxied = { ...anthropicBody, base_url: 'https://gateway.internal.example.com/v1' };
    const response = await settingsRouter.request('/model-providers', putInit(proxied));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: configured('anthropic', withRedactedApiKey({ ...anthropicProvider, base_url: proxied.base_url })),
    });
  });

  it('PUT allows several caller-supplied providers, which each name their own endpoint', async () => {
    const { settingsRouter } = await createRouters();
    const second = { ...customBody, name: 'internal-eu', base_url: 'https://llm.eu.example.com/v1' };
    expect((await settingsRouter.request('/model-providers', putInit(customBody))).status).toBe(200);
    expect((await settingsRouter.request('/model-providers', putInit(second))).status).toBe(200);

    const list = await settingsRouter.request('/model-providers');
    expect(await list.json()).toEqual({
      data: [configured('internal', customBodyWire), configured('internal-eu', withRedactedApiKey(second))],
    });
  });
});

describe('model-provider secret redaction and strict PUT', () => {
  it('PUT create with a redacted api_key returns 400', async () => {
    const { settingsRouter } = await createRouters();
    const response = await settingsRouter.request(
      '/model-providers',
      putInit({
        ...anthropicBody,
        auth: { api_key: SECRET_REDACTION },
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: 'API key is required. Add an API key for this provider, then save again.' },
    });
  });

  it('POST create with a redacted api_key returns 400', async () => {
    const { settingsRouter } = await createRouters();
    const response = await settingsRouter.request(
      '/model-providers',
      postInit({
        ...anthropicBody,
        auth: { api_key: SECRET_REDACTION },
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: 'API key is required. Add an API key for this provider, then save again.' },
    });
  });

  it('PUT rejects a missing api_key at the Zod layer', async () => {
    const { settingsRouter } = await createRouters();
    const response = await settingsRouter.request('/model-providers', putInit({ ...anthropicBody, auth: {} }));
    expect(response.status).toBe(400);
  });

  it('POST create without a key returns 400 for a provider that needs one', async () => {
    const { settingsRouter } = await createRouters();
    const { auth: _auth, ...keyless } = anthropicBody;
    const response = await settingsRouter.request('/model-providers', postInit(keyless));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: 'API key is required. Add an API key for this provider, then save again.' },
    });
  });

  it('PUT create without a key returns 400 for a provider that needs one', async () => {
    const { settingsRouter } = await createRouters();
    const { auth: _auth, ...keyless } = anthropicBody;
    const response = await settingsRouter.request('/model-providers', putInit(keyless));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: 'API key is required. Add an API key for this provider, then save again.' },
    });
  });

  it('PUT without a key keeps the stored key', async () => {
    const { settingsRouter, modelProviderStore } = await createRouters();
    expect((await settingsRouter.request('/model-providers', putInit(anthropicBody))).status).toBe(200);

    const { auth: _auth, ...keyless } = anthropicBody;
    const update = await settingsRouter.request(
      '/model-providers',
      putInit({
        ...keyless,
        models: [model, { model_id: 'claude-opus-4', name: 'claude-opus-4', properties: model.properties }],
      }),
    );
    expect(update.status).toBe(200);
    const stored = await modelProviderStore.getProvider({
      tenant_id: 'default',
      name: 'anthropic',
      model_name: 'claude-sonnet-4-6',
    });
    expect(stored?.manifest.auth?.api_key).toBe('sk-ant-secret');
    expect(stored?.manifest.models).toHaveLength(2);
  });

  it('PUT with a redacted api_key keeps the stored secret', async () => {
    const { settingsRouter, modelProviderStore } = await createRouters();
    expect((await settingsRouter.request('/model-providers', putInit(anthropicBody))).status).toBe(200);

    const redactedKeep = {
      ...anthropicBody,
      auth: { api_key: SECRET_REDACTION },
      models: [
        model,
        {
          model_id: 'claude-opus-4',
          name: 'claude-opus-4',
          properties: model.properties,
        },
      ],
    };
    const update = await settingsRouter.request('/model-providers', putInit(redactedKeep));
    expect(update.status).toBe(200);
    const updateBody = (await update.json()) as {
      data: { name: string; manifest: { auth: { api_key: string }; models: unknown[] } };
    };
    expect(updateBody.data.manifest.auth.api_key).toBe(SECRET_REDACTION);
    expect(updateBody.data.manifest.models).toHaveLength(2);

    const stored = await modelProviderStore.getProvider({
      tenant_id: 'default',
      name: 'anthropic',
      model_name: 'claude-sonnet-4-6',
    });
    if (!stored || !('auth' in stored.manifest)) {
      throw new Error('expected stored anthropic provider with auth');
    }
    expect(stored.manifest.auth?.api_key).toBe('sk-ant-secret');
  });

  it('PUT with a real api_key rotates the stored secret', async () => {
    const { settingsRouter, modelProviderStore } = await createRouters();
    expect((await settingsRouter.request('/model-providers', putInit(anthropicBody))).status).toBe(200);

    const rotatedKey = 'sk-ant-rotated-key';
    const rotated = { ...anthropicBody, auth: { api_key: rotatedKey } };
    const update = await settingsRouter.request('/model-providers', putInit(rotated));
    expect(update.status).toBe(200);
    expect((await update.json()) as { data: { name: string; manifest: { auth: { api_key: string } } } }).toEqual({
      data: configured('anthropic', withRedactedApiKey({ ...anthropicProvider, auth: { api_key: rotatedKey } })),
    });

    const stored = await modelProviderStore.getProvider({
      tenant_id: 'default',
      name: 'anthropic',
      model_name: 'claude-sonnet-4-6',
    });
    if (!stored || !('auth' in stored.manifest)) {
      throw new Error('expected stored anthropic provider with auth');
    }
    expect(stored.manifest.auth?.api_key).toBe(rotatedKey);
  });
});

describe('DELETE /model-providers/{name}', () => {
  it('deletes an existing provider and it disappears from list', async () => {
    const { settingsRouter } = await createRouters();
    expect((await settingsRouter.request('/model-providers', putInit(anthropicBody))).status).toBe(200);

    const deleted = await settingsRouter.request('/model-providers/anthropic', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({});

    const list = await settingsRouter.request('/model-providers');
    expect(await list.json()).toEqual({ data: [] });
  });

  it('returns 404 for an unknown provider name', async () => {
    const { settingsRouter } = await createRouters();
    const response = await settingsRouter.request('/model-providers/does-not-exist', { method: 'DELETE' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { message: 'No model provider with this name: does-not-exist' },
    });
  });
});

describe('catalog presets are configurable', () => {
  // A preset is copied into a PUT body with an api_key added, so every catalog type must parse.
  // `custom` is appended by the catalog route, not ModelCatalog — only well-known presets appear here.
  it.each(ModelCatalog.load().list())('PUT accepts the $type preset', async preset => {
    const { settingsRouter } = await createRouters();
    // `logo` is catalog-only metadata and a well-known provider takes its name from `type`; the rest
    // copies straight into a PUT body.
    const { logo, ...presetFields } = preset;
    const body = {
      ...presetFields,
      auth: { api_key: `sk-${preset.type}` },
    };
    expect(logo === undefined || typeof logo === 'string').toBe(true);
    const response = await settingsRouter.request('/model-providers', putInit(body));
    expect(response.status).toBe(200);
    const json = (await response.json()) as { data: { name: string; manifest: { auth: { api_key: string } } } };
    expect(json.data.manifest.auth.api_key).toBe(SECRET_REDACTION);
    expect(JSON.stringify(json)).not.toContain(body.auth.api_key);
  });
});

describe('model token limits', () => {
  const badModel = {
    ...model,
    properties: { context_length: 8000, max_output_tokens: 7600 }, // 7600 + 512 reaches 8000
  };
  const badBody = { ...customBody, models: [badModel] };

  it('PUT rejects a model whose max output plus the safety reserve reaches the context length', async () => {
    const { settingsRouter, modelProviderStore } = await createRouters();
    const response = await settingsRouter.request('/model-providers', putInit(badBody));
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain(
      'Max output tokens must be less than the context length (8,000) minus a small reserve.',
    );
    expect(await modelProviderStore.listProviders({ tenant_id: 'default' })).toEqual([]);
  });

  it('an already-stored bad config still loads but cannot be re-saved until fixed', async () => {
    const { settingsRouter, modelsRouter, modelProviderStore } = await createRouters();
    await modelProviderStore.upsertProvider({ tenant_id: 'default', name: 'internal', manifest: badBody });

    const list = await settingsRouter.request('/model-providers');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ data: [configured('internal', withRedactedApiKey(badBody))] });
    const models = await modelsRouter.request('/');
    expect(models.status).toBe(200);

    expect((await settingsRouter.request('/model-providers', putInit(badBody))).status).toBe(400);

    const fixed = {
      ...customBody,
      models: [{ ...model, properties: { context_length: 8000, max_output_tokens: 4096 } }],
    };
    expect((await settingsRouter.request('/model-providers', putInit(fixed))).status).toBe(200);
  });
});

describe('environment-managed Token Factory provider', () => {
  const tokenFactoryBody = {
    type: 'tokenfactory' as const,
    auth: { api_key: 'sk-nebius-secret' },
    models: [{ model_id: 'nvidia/nemotron-3-super-120b-a12b', name: 'nemotron-3-super-120b-a12b', properties: {} }],
  };

  async function createManaged() {
    const routers = await createRouters({ envManagedNames: new Set(['tokenfactory']) });
    await routers.modelProviderStore.upsertProvider({
      tenant_id: STANDALONE_REQUEST_CONTEXT.tenant_id,
      name: 'tokenfactory',
      manifest: { ...tokenFactoryBody, base_url: 'https://api.tokenfactory.nebius.com/v1' },
    });
    return routers;
  }

  it('marks the provider env_managed on list and keeps the key redacted', async () => {
    const { settingsRouter } = await createManaged();
    await settingsRouter.request('/model-providers', putInit(anthropicBody));

    const list = await settingsRouter.request('/model-providers');
    const body = await list.json();

    expect(body).toEqual({
      data: [
        configured('anthropic', anthropicProviderWire),
        {
          name: 'tokenfactory',
          env_managed: true,
          manifest: {
            ...tokenFactoryBody,
            base_url: 'https://api.tokenfactory.nebius.com/v1',
            auth: { api_key: SECRET_REDACTION },
          },
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('sk-nebius-secret');
  });

  it('does not mark the provider when the environment does not own it', async () => {
    const { settingsRouter, modelProviderStore } = await createRouters();
    await modelProviderStore.upsertProvider({
      tenant_id: STANDALONE_REQUEST_CONTEXT.tenant_id,
      name: 'tokenfactory',
      manifest: { ...tokenFactoryBody, base_url: 'https://api.tokenfactory.nebius.com/v1' },
    });

    const list = await settingsRouter.request('/model-providers');
    const { data } = ListModelProvidersResponseSchema.parse(await list.json());

    expect(data[0]).not.toHaveProperty('env_managed');
  });

  it('refuses PUT, POST and DELETE on it with a typed 409 and leaves the stored key alone', async () => {
    const { settingsRouter, modelProviderStore } = await createManaged();
    const conflict = {
      error: {
        message: 'Model provider tokenfactory is managed by the server environment and cannot be changed here.',
        type: 'conflict',
        code: 'env_managed_provider',
      },
    };

    const put = await settingsRouter.request(
      '/model-providers',
      putInit({ ...tokenFactoryBody, auth: { api_key: 'sk-other' } }),
    );
    const post = await settingsRouter.request('/model-providers', postInit(tokenFactoryBody));
    const del = await settingsRouter.request('/model-providers/tokenfactory', { method: 'DELETE' });

    for (const response of [put, post, del]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(conflict);
    }
    const stored = await modelProviderStore.getProvider({
      tenant_id: STANDALONE_REQUEST_CONTEXT.tenant_id,
      name: 'tokenfactory',
      model_name: '',
    });
    expect(stored?.manifest.auth?.api_key).toBe('sk-nebius-secret');
  });

  it('still lets other providers be written', async () => {
    const { settingsRouter } = await createManaged();
    const response = await settingsRouter.request('/model-providers', putInit(anthropicBody));
    expect(response.status).toBe(200);
  });
});

describe('save-time connection check', () => {
  const answeredCheck: ModelProviderCheck = {
    kind: 'answered',
    message: 'The model server answered the test call.',
    checked_at: '2026-11-09T12:00:00.000Z',
  };
  const refusedCheck: ModelProviderCheck = {
    kind: 'key_refused',
    message: 'The model server refused the API key. Check the key for this provider and save again.',
    checked_at: '2026-11-09T12:00:00.000Z',
  };

  it('POST returns the check outcome and the list shows it afterwards', async () => {
    const seen: string[] = [];
    const { settingsRouter } = await createRouters({
      checkSavedProvider: async ({ record }) => {
        seen.push(record.name);
        return answeredCheck;
      },
    });

    const created = await settingsRouter.request('/model-providers', postInit(customBody));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      data: { ...configured('internal', customBodyWire), last_check: answeredCheck },
    });
    expect(seen).toEqual(['internal']);

    const list = await settingsRouter.request('/model-providers');
    expect(await list.json()).toEqual({
      data: [{ ...configured('internal', customBodyWire), last_check: answeredCheck }],
    });
  });

  it('PUT still saves when the check finds the key refused, and records the outcome', async () => {
    const { settingsRouter, modelProviderStore } = await createRouters({
      checkSavedProvider: async () => refusedCheck,
    });

    const response = await settingsRouter.request('/model-providers', putInit(customBody));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { ...configured('internal', customBodyWire), last_check: refusedCheck },
    });

    const stored = await modelProviderStore.getProvider({
      tenant_id: 'default',
      name: 'internal',
      model_name: 'claude-sonnet-4-6',
    });
    expect(stored?.last_check).toEqual(refusedCheck);
  });

  it('a checker that throws still saves, with no outcome shown', async () => {
    const { settingsRouter } = await createRouters({
      checkSavedProvider: async () => {
        throw new Error('checker blew up');
      },
    });

    const response = await settingsRouter.request('/model-providers', putInit(customBody));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: configured('internal', customBodyWire) });

    const list = await settingsRouter.request('/model-providers');
    expect(await list.json()).toEqual({ data: [configured('internal', customBodyWire)] });
  });
});

describe('GET /models default chat model', () => {
  it('lists the stored default chat model first and keeps the rest in order', async () => {
    const { settingsRouter, modelsRouter, globalSettingsStore } = await createRouters();
    await settingsRouter.request('/model-providers', putInit(anthropicBody));
    await settingsRouter.request('/model-providers', putInit(customBody));
    await globalSettingsStore.setSetting({ key: 'default_chat_model', value: 'internal/claude-sonnet-4-6' });

    const response = await modelsRouter.request('/');
    const { data } = ListAvailableModelsResponseSchema.parse(await response.json());

    expect(data.map(item => item.name)).toEqual(['internal/claude-sonnet-4-6', 'anthropic/claude-sonnet-4-6']);
  });

  it('ignores a stored default that is no longer listed', async () => {
    const { settingsRouter, modelsRouter, globalSettingsStore } = await createRouters();
    await settingsRouter.request('/model-providers', putInit(anthropicBody));
    await globalSettingsStore.setSetting({ key: 'default_chat_model', value: 'tokenfactory/gone' });

    const { data } = ListAvailableModelsResponseSchema.parse(await (await modelsRouter.request('/')).json());

    expect(data.map(item => item.name)).toEqual(['anthropic/claude-sonnet-4-6']);
  });
});

describe('a model on the same computer as an installed Aman', () => {
  // The app runs in containers on networks of their own, so this computer's home network address, its Tailscale
  // address and name, and host.docker.internal (Docker's gateway to this computer) are not the app's own addresses.
  const lookups = fixedLookups({
    'spark.example.ts.net': ['100.101.102.103'],
    spark: ['192.168.1.20'],
    'host.docker.internal': ['172.17.0.1'],
  });
  const localBody = (base_url: string) => ({ ...customBody, name: 'spark', base_url });

  beforeEach(() => {
    configureRemoteAddressCheck({ ownNetworkRanges: ['172.18.0.0/16', '172.19.0.0/16'] });
  });

  afterEach(() => {
    configureRemoteAddressCheck({ ownNetworkRanges: [] });
  });

  it.each([
    ['its Tailscale name', 'https://spark.example.ts.net:8443/v1'],
    ['its Tailscale address', 'http://100.101.102.103:30031/v1'],
    ['its home network address', 'http://192.168.1.20:30031/v1'],
    ['a short name that resolves to it', 'http://spark:30031/v1'],
    ['host.docker.internal', 'http://host.docker.internal:11434/v1'],
  ])('is saved when given by %s', async (_label, baseUrl) => {
    const { settingsRouter, modelProviderStore } = await createRouters({ resolveHostAddresses: lookups });

    expect((await settingsRouter.request('/model-providers', postInit(localBody(baseUrl)))).status).toBe(201);
    expect((await settingsRouter.request('/model-providers', putInit(localBody(baseUrl)))).status).toBe(200);
    const saved = await modelProviderStore.listProviders({ tenant_id: STANDALONE_REQUEST_CONTEXT.tenant_id });
    expect(saved.map(record => record.manifest.base_url)).toEqual([baseUrl]);
  });
});

describe("the local model bridge's address on an instance network", () => {
  // The bridge answers on a network the app's containers share, so the address check refuses it
  // unless aman local-model has listed its endpoint.
  const lookups = fixedLookups({ 'aman-local-model': ['172.30.5.2'] });
  const bridgeBody = { ...customBody, name: 'bridged', base_url: 'http://aman-local-model:30031/v1' };
  const originalEndpoints = configuration.LOCAL_MODEL_ENDPOINTS;

  beforeEach(() => {
    configureRemoteAddressCheck({ ownNetworkRanges: ['172.30.0.0/16'] });
  });

  afterEach(() => {
    configureRemoteAddressCheck({ ownNetworkRanges: [] });
    configuration.LOCAL_MODEL_ENDPOINTS = originalEndpoints;
  });

  it('is refused, with the command that adds its port, while its endpoint is not listed', async () => {
    configuration.LOCAL_MODEL_ENDPOINTS = ['aman-local-model:11434'];
    const { settingsRouter, modelProviderStore } = await createRouters({ resolveHostAddresses: lookups });

    for (const init of [postInit(bridgeBody), putInit(bridgeBody)]) {
      const response = await settingsRouter.request('/model-providers', init);
      expect(response.status).toBe(400);
      const body = RequestErrorResponseSchema.parse(await response.json());
      expect(body.error.message).toContain('run aman local-model 30031');
    }
    expect(await modelProviderStore.listProviders({ tenant_id: STANDALONE_REQUEST_CONTEXT.tenant_id })).toEqual([]);
  });

  it('is saved once its endpoint is listed', async () => {
    configuration.LOCAL_MODEL_ENDPOINTS = ['localhost:11434', 'aman-local-model:30031'];
    const { settingsRouter } = await createRouters({ resolveHostAddresses: lookups });

    expect((await settingsRouter.request('/model-providers', postInit(bridgeBody))).status).toBe(201);
    expect((await settingsRouter.request('/model-providers', putInit(bridgeBody))).status).toBe(200);
  });
});

describe('the address check on model providers', () => {
  function customAt(name: string, baseUrl: string) {
    return { type: 'custom' as const, name, base_url: baseUrl, auth: { api_key: 'sk-custom' }, models: [model] };
  }

  async function errorMessage(response: Response): Promise<string> {
    return RequestErrorResponseSchema.parse(await response.json()).error.message;
  }

  it('refuses a provider at a loopback address, naming the setting that allows a local model', async () => {
    const { settingsRouter } = await createRouters();

    const response = await settingsRouter.request(
      '/model-providers',
      putInit(customAt('local-refused', 'http://127.0.0.1:11434/v1')),
    );

    expect(response.status).toBe(400);
    expect(await errorMessage(response)).toContain('LOCAL_MODEL_ENDPOINTS');
    const list = await settingsRouter.request('/model-providers');
    expect(await list.json()).toEqual({ data: [] });
  });

  it('refuses a provider at the cloud metadata address', async () => {
    const { settingsRouter } = await createRouters();

    const response = await settingsRouter.request(
      '/model-providers',
      postInit(customAt('metadata-refused', 'http://169.254.169.254/v1')),
    );

    expect(response.status).toBe(400);
    const message = await errorMessage(response);
    expect(message).toContain('That address is on this computer, so the server cannot use it for a model');
    expect(message).toContain('~/.amanuensis/instances/<name>/.env');
    expect(message).toContain('Restart the instance after changing it');
  });

  it('refuses an address carrying a name and password', async () => {
    const { settingsRouter } = await createRouters();

    const response = await settingsRouter.request(
      '/model-providers',
      putInit(customAt('credentialed-refused', 'https://user:secret@8.8.8.8/v1')),
    );

    expect(response.status).toBe(400);
    expect(await errorMessage(response)).toContain('without a name and password in it');
  });

  it('saves a provider at a public address', async () => {
    const { settingsRouter } = await createRouters();

    const response = await settingsRouter.request(
      '/model-providers',
      putInit(customAt('public-allowed', 'https://8.8.8.8/v1')),
    );

    expect(response.status).toBe(200);
  });

  it('saves a provider at a loopback address once the operator names its exact endpoint', async () => {
    const { settingsRouter } = await createRouters();
    const originalEndpoints = configuration.LOCAL_MODEL_ENDPOINTS;
    configuration.LOCAL_MODEL_ENDPOINTS = ['127.0.0.1:11434', 'localhost:11434'];
    try {
      const byLiteral = await settingsRouter.request(
        '/model-providers',
        putInit(customAt('local-allowed', 'http://127.0.0.1:11434/v1')),
      );
      expect(byLiteral.status).toBe(200);

      const byName = await settingsRouter.request(
        '/model-providers',
        putInit(customAt('local-named', 'http://localhost:11434/v1')),
      );
      expect(byName.status).toBe(200);
    } finally {
      configuration.LOCAL_MODEL_ENDPOINTS = originalEndpoints;
    }
  });

  it('a named endpoint does not cover a different port on the same host', async () => {
    const { settingsRouter } = await createRouters();
    const originalEndpoints = configuration.LOCAL_MODEL_ENDPOINTS;
    configuration.LOCAL_MODEL_ENDPOINTS = ['127.0.0.1:11434'];
    try {
      const response = await settingsRouter.request(
        '/model-providers',
        putInit(customAt('local-wrong-port', 'http://127.0.0.1:9999/v1')),
      );

      expect(response.status).toBe(400);
    } finally {
      configuration.LOCAL_MODEL_ENDPOINTS = originalEndpoints;
    }
  });
});
