export {};

const KEYS = ['APP_DATA_DIR', 'APP_DATA_DIR_SUFFIX', 'SQLITE_PATH', 'STANDALONE'] as const;

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

describe('app data dir config', () => {
  it('roots every derived data path under APP_DATA_DIR', async () => {
    const { default: configuration } = await loadConfig({ APP_DATA_DIR: '/data/app' });
    if (!configuration.STANDALONE) {
      throw new Error('expected standalone configuration');
    }
    expect(configuration.SQLITE_PATH).toBe('/data/app/db/db.sqlite');
    expect(configuration.LOCAL_SANDBOX_ROOT_PARENT).toBe('/data/app/sandboxes');
    expect(configuration.SANDBOX_RUNS_DIR).toBe('/data/app/sandbox-runs');
    expect(configuration.SANDBOX_STATE_DIR).toBe('/data/app/sandbox-state');
    expect(configuration.SANDBOX_GIT_BRIDGE_DIR).toBe('/data/app/git-bridge');
  });

  it('lets APP_DATA_DIR win over APP_DATA_DIR_SUFFIX, and SQLITE_PATH win over both', async () => {
    const { default: configuration } = await loadConfig({
      APP_DATA_DIR: '/data/app',
      APP_DATA_DIR_SUFFIX: 'dev',
      SQLITE_PATH: '/elsewhere/db.sqlite',
    });
    if (!configuration.STANDALONE) {
      throw new Error('expected standalone configuration');
    }
    expect(configuration.SANDBOX_RUNS_DIR).toBe('/data/app/sandbox-runs');
    expect(configuration.SQLITE_PATH).toBe('/elsewhere/db.sqlite');
  });

  it('falls back to the OS data dir when APP_DATA_DIR is blank', async () => {
    const { default: configuration } = await loadConfig({ APP_DATA_DIR: '  ', APP_DATA_DIR_SUFFIX: 'unit' });
    expect(configuration.SANDBOX_RUNS_DIR).toMatch(/trueforge-unit[\\/]sandbox-runs$/);
  });
});
