import { createLogger } from 'winston';

import type { GoogleConnectionRecord, GoogleConnectionStore } from '@truefoundry/trueforge-core/core/google/connection';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';

import { probeConnectors, probeGoogleLogin, probeModel } from '../../../src/help/healthProbes';
import { DEFAULT_CHAT_MODEL_SETTING_KEY } from '../../../src/runtime/tokenFactoryProvider';
import type { ModelProviderManifest } from '../../../src/schemas/modelProvider';

const mockCreateNonStream = jest.fn();

jest.mock('@truefoundry/trueforge-core/core', () => {
  const actual = jest.requireActual<typeof import('@truefoundry/trueforge-core/core')>(
    '@truefoundry/trueforge-core/core',
  );
  return {
    ...actual,
    VercelAILLM: jest.fn().mockImplementation(() => ({
      createNonStream: (...args: unknown[]) => mockCreateNonStream(...args),
    })),
  };
});

// The model store is a database lookup, so the probe test replaces it with a provider stub.
jest.mock('../../../src/runtime/sessionResources', () => ({
  getModelDetails: jest.fn(async ({ name }: { name: string }) => {
    if (name === 'openai/unknown') {
      throw new Error('Unknown model "openai/unknown" — provider not configured');
    }
    return { providerConfig: { provider: { type: 'openai' }, model: name }, streamTimeout: undefined };
  }),
  getMcpConnection: jest.fn(),
}));

const silentLogger = createLogger({ silent: true });
const TENANT = 'default';

/** Lists one provider with the given models, so they show in the catalog a chat picks from. */
async function listOpenAiModels(modelProviderStore: SqliteModelProviderStore, modelIds: string[]) {
  await modelProviderStore.createProvider({
    tenant_id: TENANT,
    name: 'openai',
    manifest: {
      type: 'openai',
      base_url: 'https://api.openai.com/v1',
      auth: { api_key: 'sk-test' },
      models: modelIds.map(model_id => ({ model_id, name: model_id, properties: { context_length: 8000 } })),
    },
  });
}

async function setup() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  return {
    globalSettingsStore: new SqliteGlobalSettingsStore(db),
    modelProviderStore: new SqliteModelProviderStore(db),
    mcpServerStore: new SqliteMcpServerStore(db),
    tokenStore: new SqliteOAuthTokenStore(db),
  };
}

beforeEach(() => {
  mockCreateNonStream.mockReset();
});

describe('probeModel', () => {
  it('reports no default when no default chat model is stored', async () => {
    const { globalSettingsStore, modelProviderStore } = await setup();

    await expect(
      probeModel({ tenantId: TENANT, modelProviderStore, globalSettingsStore, logger: silentLogger }),
    ).resolves.toEqual({ kind: 'no_default' });
    expect(mockCreateNonStream).not.toHaveBeenCalled();
  });

  it('reports no default when the catalog has no model at all', async () => {
    const { globalSettingsStore, modelProviderStore } = await setup();

    await expect(
      probeModel({ tenantId: TENANT, modelProviderStore, globalSettingsStore, logger: silentLogger }),
    ).resolves.toEqual({ kind: 'no_default' });
  });

  it('tests a custom provider model as the chat would, with no stored default', async () => {
    const { globalSettingsStore, modelProviderStore } = await setup();
    const manifest = {
      type: 'custom',
      name: 'my-llm',
      base_url: 'https://llm.example.test/v1',
      models: [{ model_id: 'llama-3', name: 'llama-3', properties: { context_length: 8000 } }],
    } satisfies ModelProviderManifest;
    await modelProviderStore.createProvider({ tenant_id: TENANT, name: 'my-llm', manifest });
    mockCreateNonStream.mockResolvedValue({ output: { content: 'ok' } });

    await expect(
      probeModel({ tenantId: TENANT, modelProviderStore, globalSettingsStore, logger: silentLogger }),
    ).resolves.toEqual({ kind: 'answered' });
    expect(mockCreateNonStream).toHaveBeenCalledTimes(1);
  });

  it('reports a misconfigured default when its provider cannot be loaded, without calling the model', async () => {
    const { globalSettingsStore, modelProviderStore } = await setup();
    await listOpenAiModels(modelProviderStore, ['unknown']);
    await globalSettingsStore.setSetting({ key: DEFAULT_CHAT_MODEL_SETTING_KEY, value: 'openai/unknown' });

    await expect(
      probeModel({ tenantId: TENANT, modelProviderStore, globalSettingsStore, logger: silentLogger }),
    ).resolves.toEqual({ kind: 'misconfigured' });
    expect(mockCreateNonStream).not.toHaveBeenCalled();
  });

  it('reports an unreachable model when the one tiny test call fails', async () => {
    const { globalSettingsStore, modelProviderStore } = await setup();
    await listOpenAiModels(modelProviderStore, ['model-a']);
    await globalSettingsStore.setSetting({ key: DEFAULT_CHAT_MODEL_SETTING_KEY, value: 'openai/model-a' });
    mockCreateNonStream.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(
      probeModel({ tenantId: TENANT, modelProviderStore, globalSettingsStore, logger: silentLogger }),
    ).resolves.toEqual({ kind: 'no_answer' });
    expect(mockCreateNonStream).toHaveBeenCalledTimes(1);
    expect(mockCreateNonStream.mock.calls[0]?.[0]).toMatchObject({ max_completion_tokens: 8 });
  });

  it('reports the model as answered when the test call succeeds', async () => {
    const { globalSettingsStore, modelProviderStore } = await setup();
    await listOpenAiModels(modelProviderStore, ['model-a']);
    await globalSettingsStore.setSetting({ key: DEFAULT_CHAT_MODEL_SETTING_KEY, value: 'openai/model-a' });
    mockCreateNonStream.mockResolvedValue({ output: { content: 'ok' } });

    await expect(
      probeModel({ tenantId: TENANT, modelProviderStore, globalSettingsStore, logger: silentLogger }),
    ).resolves.toEqual({ kind: 'answered' });
  });
});

describe('probeConnectors', () => {
  it('returns no connectors when none are set up', async () => {
    const { mcpServerStore, tokenStore } = await setup();

    await expect(
      probeConnectors({
        tenantId: TENANT,
        userRef: 'person-a',
        mcpServerStore,
        tokenStore,
        clientName: undefined,
        requestTimeoutMs: 1_000,
        connectTimeoutMs: 1_000,
        logger: silentLogger,
      }),
    ).resolves.toEqual([]);
  });
});

describe('probeGoogleLogin', () => {
  const OWNER = { tenant_id: TENANT, created_by: 'person-a' };
  const MAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

  function connectionWith(overrides: Partial<GoogleConnectionRecord>): GoogleConnectionStore {
    const record: GoogleConnectionRecord = {
      ...OWNER,
      client_id: 'client-id',
      client_secret: 'client-secret',
      client_type: 'web',
      refresh_token: 'refresh-token',
      granted_scopes: [MAIL_SCOPE],
      account_email: null,
      status: 'connected',
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
      ...overrides,
    };
    return {
      get: jest.fn(async () => record),
      save: jest.fn(),
      markNeedsReconnect: jest.fn(async () => true),
      setAccountEmail: jest.fn(async () => true),
      delete: jest.fn(),
    };
  }

  const tokenFetch = (async () =>
    new Response(JSON.stringify({ access_token: 'access', expires_in: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  it('reports not set up when no Google login exists', async () => {
    const connections = connectionWith({});
    jest.mocked(connections.get).mockResolvedValue(null);

    await expect(
      probeGoogleLogin({ owner: OWNER, connections, fetchImpl: tokenFetch, logger: silentLogger }),
    ).resolves.toBe('not_set_up');
  });

  it('reports not set up when the login grants neither Gmail nor Calendar', async () => {
    const connections = connectionWith({ granted_scopes: [] });

    await expect(
      probeGoogleLogin({ owner: OWNER, connections, fetchImpl: tokenFetch, logger: silentLogger }),
    ).resolves.toBe('not_set_up');
  });

  it('reports the login as answered when Google gives a token for a Gmail grant', async () => {
    const connections = connectionWith({});

    await expect(
      probeGoogleLogin({ owner: OWNER, connections, fetchImpl: tokenFetch, logger: silentLogger }),
    ).resolves.toBe('answered');
  });

  it('reports needs reconnect when the stored login is already flagged', async () => {
    const connections = connectionWith({ status: 'needs_reconnect' });

    await expect(
      probeGoogleLogin({ owner: OWNER, connections, fetchImpl: tokenFetch, logger: silentLogger }),
    ).resolves.toBe('needs_reconnect');
  });
});
