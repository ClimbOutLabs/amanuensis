import { createLogger } from 'winston';

import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import { probeConnectors, probeModel } from '../../../src/help/healthProbes';
import { DEFAULT_CHAT_MODEL_SETTING_KEY } from '../../../src/runtime/tokenFactoryProvider';

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
    if (name === 'tokenfactory/unknown') {
      throw new Error('Unknown model "tokenfactory/unknown" — provider not configured');
    }
    return { providerConfig: { provider: { type: 'tokenfactory' }, model: name }, streamTimeout: undefined };
  }),
  getMcpConnection: jest.fn(),
}));

const silentLogger = createLogger({ silent: true });
const TENANT = 'default';

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

  it('reports a misconfigured default when its provider cannot be loaded, without calling the model', async () => {
    const { globalSettingsStore, modelProviderStore } = await setup();
    await globalSettingsStore.setSetting({ key: DEFAULT_CHAT_MODEL_SETTING_KEY, value: 'tokenfactory/unknown' });

    await expect(
      probeModel({ tenantId: TENANT, modelProviderStore, globalSettingsStore, logger: silentLogger }),
    ).resolves.toEqual({ kind: 'misconfigured' });
    expect(mockCreateNonStream).not.toHaveBeenCalled();
  });

  it('reports an unreachable model when the one tiny test call fails', async () => {
    const { globalSettingsStore, modelProviderStore } = await setup();
    await globalSettingsStore.setSetting({ key: DEFAULT_CHAT_MODEL_SETTING_KEY, value: 'tokenfactory/model-a' });
    mockCreateNonStream.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(
      probeModel({ tenantId: TENANT, modelProviderStore, globalSettingsStore, logger: silentLogger }),
    ).resolves.toEqual({ kind: 'no_answer' });
    expect(mockCreateNonStream).toHaveBeenCalledTimes(1);
    expect(mockCreateNonStream.mock.calls[0]?.[0]).toMatchObject({ max_completion_tokens: 8 });
  });

  it('reports the model as answered when the test call succeeds', async () => {
    const { globalSettingsStore, modelProviderStore } = await setup();
    await globalSettingsStore.setSetting({ key: DEFAULT_CHAT_MODEL_SETTING_KEY, value: 'tokenfactory/model-a' });
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
