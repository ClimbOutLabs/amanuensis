/** Token Factory settings: env-managed provider inputs and the daily token cap. */
describe('token factory config', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
    delete process.env['NEBIUS_API_KEY'];
    delete process.env['TOKEN_FACTORY_MODEL'];
    delete process.env['TOKEN_FACTORY_CHEAPER_MODEL'];
    delete process.env['TOKEN_FACTORY_DAILY_TOKEN_CAP'];
    delete process.env['TOKEN_FACTORY_PRICES'];
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  async function loadConfig(): Promise<typeof import('../../../src/config').default> {
    const mod = await import('../../../src/config');
    return mod.default;
  }

  it('defaults to the Nemotron model, the gpt-oss cheaper model, and no cap', async () => {
    const config = await loadConfig();
    expect(config.NEBIUS_API_KEY).toBeUndefined();
    expect(config.TOKEN_FACTORY_MODEL).toBe('nvidia/nemotron-3-super-120b-a12b');
    expect(config.TOKEN_FACTORY_CHEAPER_MODEL).toBe('openai/gpt-oss-120b');
    expect(config.TOKEN_FACTORY_DAILY_TOKEN_CAP).toBeUndefined();
  });

  it('reads the model overrides and the daily cap', async () => {
    process.env['TOKEN_FACTORY_MODEL'] = 'Qwen/Qwen3-235B-A22B-Instruct-2507';
    process.env['TOKEN_FACTORY_CHEAPER_MODEL'] = 'openai/gpt-oss-20b';
    process.env['TOKEN_FACTORY_DAILY_TOKEN_CAP'] = '2500000';
    const config = await loadConfig();
    expect(config.TOKEN_FACTORY_MODEL).toBe('Qwen/Qwen3-235B-A22B-Instruct-2507');
    expect(config.TOKEN_FACTORY_CHEAPER_MODEL).toBe('openai/gpt-oss-20b');
    expect(config.TOKEN_FACTORY_DAILY_TOKEN_CAP).toBe(2_500_000);
  });

  it('treats a blank cheaper model as none and a blank cap as no cap', async () => {
    process.env['TOKEN_FACTORY_CHEAPER_MODEL'] = '  ';
    process.env['TOKEN_FACTORY_DAILY_TOKEN_CAP'] = '';
    const config = await loadConfig();
    expect(config.TOKEN_FACTORY_CHEAPER_MODEL).toBeUndefined();
    expect(config.TOKEN_FACTORY_DAILY_TOKEN_CAP).toBeUndefined();
  });

  it.each(['0', '-5', '1.5', 'lots'])('rejects the daily cap %s', async raw => {
    process.env['TOKEN_FACTORY_DAILY_TOKEN_CAP'] = raw;
    await expect(loadConfig()).rejects.toThrow('TOKEN_FACTORY_DAILY_TOKEN_CAP must be an integer of at least 1');
  });

  it('has no price overrides by default', async () => {
    const config = await loadConfig();
    expect(config.TOKEN_FACTORY_PRICES).toEqual({});
  });

  it('reads price overrides from TOKEN_FACTORY_PRICES', async () => {
    process.env['TOKEN_FACTORY_PRICES'] =
      '{"nvidia/nemotron-3-super-120b-a12b":{"input_per_million":0.25,"output_per_million":0.8}}';
    const config = await loadConfig();
    expect(config.TOKEN_FACTORY_PRICES).toEqual({
      'nvidia/nemotron-3-super-120b-a12b': { input_per_million: 0.25, output_per_million: 0.8 },
    });
  });

  it.each(['{nope', '{"m":{"input_per_million":1}}'])('rejects the price overrides %s at startup', async raw => {
    process.env['TOKEN_FACTORY_PRICES'] = raw;
    await expect(loadConfig()).rejects.toThrow('TOKEN_FACTORY_PRICES must');
  });
});
