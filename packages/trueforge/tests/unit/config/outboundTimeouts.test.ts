import {
  DEFAULT_MCP_HTTP_BODY_TIMEOUT_MS,
  DEFAULT_MCP_HTTP_CONNECT_TIMEOUT_MS,
  DEFAULT_MCP_HTTP_MAX_RETRIES,
  DEFAULT_MODEL_HTTP_BODY_TIMEOUT_MS,
  DEFAULT_MODEL_HTTP_CONNECT_TIMEOUT_MS,
  DEFAULT_MODEL_HTTP_HEADERS_TIMEOUT_MS,
  DEFAULT_MODEL_HTTP_MAX_RETRIES,
} from '@truefoundry/trueforge-core/core';

const KEYS = [
  'MODEL_HTTP_CONNECT_TIMEOUT_MS',
  'MODEL_HTTP_HEADERS_TIMEOUT_MS',
  'MODEL_HTTP_BODY_TIMEOUT_MS',
  'MODEL_HTTP_MAX_RETRIES',
  'MCP_REQUEST_TIMEOUT_MS',
  'MCP_HTTP_CONNECT_TIMEOUT_MS',
  'MCP_HTTP_HEADERS_TIMEOUT_MS',
  'MCP_HTTP_BODY_TIMEOUT_MS',
  'MCP_HTTP_MAX_RETRIES',
  'TURN_SSE_STREAM_WRITE_TIMEOUT_MS',
  'STANDALONE',
  'DATABASE_URL',
  'POSTGRES_STATEMENT_TIMEOUT_MS',
  'POSTGRES_CONNECT_TIMEOUT_MS',
] as const;

type ConfigModule = typeof import('../../../src/config');

async function loadConfig(env: Partial<Record<(typeof KEYS)[number], string>>): Promise<ConfigModule> {
  const saved = KEYS.map(key => [key, process.env[key]] as const);
  for (const key of KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    let loaded: ConfigModule | undefined;
    await jest.isolateModulesAsync(async () => {
      loaded = await import('../../../src/config');
    });
    if (loaded === undefined) {
      throw new Error('config did not load');
    }
    return loaded;
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

const DISTRIBUTED = { STANDALONE: 'false', DATABASE_URL: 'postgres://user:pass@localhost:5432/db' };

describe('outbound timeout settings', () => {
  it('default to the core values, with the MCP headers wait just past the MCP request timeout', async () => {
    const { default: configuration } = await loadConfig({});
    expect(configuration.MODEL_HTTP_CONNECT_TIMEOUT_MS).toBe(DEFAULT_MODEL_HTTP_CONNECT_TIMEOUT_MS);
    expect(configuration.MODEL_HTTP_HEADERS_TIMEOUT_MS).toBe(DEFAULT_MODEL_HTTP_HEADERS_TIMEOUT_MS);
    expect(configuration.MODEL_HTTP_BODY_TIMEOUT_MS).toBe(DEFAULT_MODEL_HTTP_BODY_TIMEOUT_MS);
    expect(configuration.MODEL_HTTP_MAX_RETRIES).toBe(DEFAULT_MODEL_HTTP_MAX_RETRIES);
    expect(configuration.MCP_HTTP_CONNECT_TIMEOUT_MS).toBe(DEFAULT_MCP_HTTP_CONNECT_TIMEOUT_MS);
    expect(configuration.MCP_HTTP_HEADERS_TIMEOUT_MS).toBe(configuration.MCP_REQUEST_TIMEOUT_MS + 5_000);
    expect(configuration.MCP_HTTP_BODY_TIMEOUT_MS).toBe(DEFAULT_MCP_HTTP_BODY_TIMEOUT_MS);
    expect(configuration.MCP_HTTP_MAX_RETRIES).toBe(DEFAULT_MCP_HTTP_MAX_RETRIES);
    expect(configuration.TURN_SSE_STREAM_WRITE_TIMEOUT_MS).toBe(60_000);
  });

  it('reads each setting from the environment', async () => {
    const { default: configuration } = await loadConfig({
      MODEL_HTTP_CONNECT_TIMEOUT_MS: '1001',
      MODEL_HTTP_HEADERS_TIMEOUT_MS: '1002',
      MODEL_HTTP_BODY_TIMEOUT_MS: '1003',
      MODEL_HTTP_MAX_RETRIES: '4',
      MCP_HTTP_CONNECT_TIMEOUT_MS: '1005',
      MCP_HTTP_HEADERS_TIMEOUT_MS: '300000',
      MCP_HTTP_BODY_TIMEOUT_MS: '1007',
      MCP_HTTP_MAX_RETRIES: '5',
      TURN_SSE_STREAM_WRITE_TIMEOUT_MS: '1009',
    });
    expect(configuration.MODEL_HTTP_CONNECT_TIMEOUT_MS).toBe(1001);
    expect(configuration.MODEL_HTTP_HEADERS_TIMEOUT_MS).toBe(1002);
    expect(configuration.MODEL_HTTP_BODY_TIMEOUT_MS).toBe(1003);
    expect(configuration.MODEL_HTTP_MAX_RETRIES).toBe(4);
    expect(configuration.MCP_HTTP_CONNECT_TIMEOUT_MS).toBe(1005);
    expect(configuration.MCP_HTTP_HEADERS_TIMEOUT_MS).toBe(300_000);
    expect(configuration.MCP_HTTP_BODY_TIMEOUT_MS).toBe(1007);
    expect(configuration.MCP_HTTP_MAX_RETRIES).toBe(5);
    expect(configuration.TURN_SSE_STREAM_WRITE_TIMEOUT_MS).toBe(1009);
  });

  it('lets retries be turned off', async () => {
    const { default: configuration } = await loadConfig({ MODEL_HTTP_MAX_RETRIES: '0', MCP_HTTP_MAX_RETRIES: '0' });
    expect(configuration.MODEL_HTTP_MAX_RETRIES).toBe(0);
    expect(configuration.MCP_HTTP_MAX_RETRIES).toBe(0);
  });

  it('follows a raised MCP request timeout with the headers wait', async () => {
    const { default: configuration } = await loadConfig({ MCP_REQUEST_TIMEOUT_MS: '600000' });
    expect(configuration.MCP_HTTP_HEADERS_TIMEOUT_MS).toBe(605_000);
  });

  it('refuses an MCP headers wait that would end before the MCP request timeout reports a slow tool', async () => {
    await expect(
      loadConfig({ MCP_REQUEST_TIMEOUT_MS: '240000', MCP_HTTP_HEADERS_TIMEOUT_MS: '240000' }),
    ).rejects.toThrow(
      'MCP_HTTP_HEADERS_TIMEOUT_MS is 240000, but it must be at least 245000: MCP_REQUEST_TIMEOUT_MS plus 5000, so a slow tool is reported as slow. Raise it, or remove it to use 245000.',
    );
  });
});

describe('Postgres connection wait', () => {
  it('defaults to the statement timeout plus ten seconds, so a full pool of slow queries is waited out', async () => {
    const { default: configuration } = await loadConfig(DISTRIBUTED);
    if (configuration.STANDALONE) {
      throw new Error('expected distributed mode');
    }
    expect(configuration.POSTGRES_CONNECT_TIMEOUT_MS).toBe(70_000);
  });

  it('follows a raised statement timeout', async () => {
    const { default: configuration } = await loadConfig({ ...DISTRIBUTED, POSTGRES_STATEMENT_TIMEOUT_MS: '120000' });
    if (configuration.STANDALONE) {
      throw new Error('expected distributed mode');
    }
    expect(configuration.POSTGRES_CONNECT_TIMEOUT_MS).toBe(130_000);
  });

  it('reads an explicit value', async () => {
    const { default: configuration } = await loadConfig({ ...DISTRIBUTED, POSTGRES_CONNECT_TIMEOUT_MS: '15000' });
    if (configuration.STANDALONE) {
      throw new Error('expected distributed mode');
    }
    expect(configuration.POSTGRES_CONNECT_TIMEOUT_MS).toBe(15_000);
  });
});
