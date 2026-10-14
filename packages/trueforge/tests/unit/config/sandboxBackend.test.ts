const KEYS = ['SANDBOX_BACKEND', 'SANDBOX_SLOTS', 'SANDBOX_SLOTS_DIR', 'SANDBOX_SESSION_DISK_MB'] as const;

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

describe('sandbox backend config', () => {
  it('defaults to docker with four slots and a 2 GiB workspace quota', async () => {
    const { default: configuration } = await loadConfig({});
    expect(configuration.SANDBOX_BACKEND).toBe('docker');
    expect(configuration.SANDBOX_SLOTS).toBe(4);
    expect(configuration.SANDBOX_SLOTS_DIR).toBe('');
    expect(configuration.SANDBOX_SESSION_DISK_MB).toBe(2048);
  });

  it('accepts the slot backend with a control directory', async () => {
    const { default: configuration } = await loadConfig({
      SANDBOX_BACKEND: 'slots',
      SANDBOX_SLOTS_DIR: '/run/aman-slots',
      SANDBOX_SLOTS: '2',
    });
    expect(configuration.SANDBOX_BACKEND).toBe('slots');
    expect(configuration.SANDBOX_SLOTS).toBe(2);
  });

  it('refuses to start on the slot backend without a control directory', async () => {
    await expect(loadConfig({ SANDBOX_BACKEND: 'slots' })).rejects.toThrow('SANDBOX_SLOTS_DIR is required');
  });

  it('refuses more slots than the compose file defines', async () => {
    await expect(loadConfig({ SANDBOX_BACKEND: 'slots', SANDBOX_SLOTS_DIR: '/x', SANDBOX_SLOTS: '9' })).rejects.toThrow(
      'at most 4',
    );
  });

  it('refuses an unknown backend instead of falling back', async () => {
    await expect(loadConfig({ SANDBOX_BACKEND: 'host' })).rejects.toThrow(
      'SANDBOX_BACKEND must be one of docker, slots',
    );
  });
});
