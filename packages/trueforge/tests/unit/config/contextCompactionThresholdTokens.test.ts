import { parseOptionalPositiveInt } from '../../../src/config';

describe('CONTEXT_COMPACTION_THRESHOLD_TOKENS env parsing', () => {
  it.each([undefined, '', '   '])('stays unset for %j so the model context length decides', raw => {
    expect(parseOptionalPositiveInt({ envKey: 'CONTEXT_COMPACTION_THRESHOLD_TOKENS', raw })).toBeUndefined();
  });

  it('accepts a positive integer override', () => {
    expect(parseOptionalPositiveInt({ envKey: 'CONTEXT_COMPACTION_THRESHOLD_TOKENS', raw: '80000' })).toBe(80_000);
  });

  it.each(['0', '-5', '1.5', 'abc'])('rejects %j', raw => {
    expect(() => parseOptionalPositiveInt({ envKey: 'CONTEXT_COMPACTION_THRESHOLD_TOKENS', raw })).toThrow(
      'must be an integer of at least 1',
    );
  });
});

describe('server configuration CONTEXT_COMPACTION_THRESHOLD_TOKENS', () => {
  const originalValue = process.env['CONTEXT_COMPACTION_THRESHOLD_TOKENS'];

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env['CONTEXT_COMPACTION_THRESHOLD_TOKENS'];
    } else {
      process.env['CONTEXT_COMPACTION_THRESHOLD_TOKENS'] = originalValue;
    }
    jest.resetModules();
  });

  async function loadedThreshold(env: string | undefined): Promise<number | undefined> {
    if (env === undefined) {
      delete process.env['CONTEXT_COMPACTION_THRESHOLD_TOKENS'];
    } else {
      process.env['CONTEXT_COMPACTION_THRESHOLD_TOKENS'] = env;
    }
    jest.resetModules();
    const { default: configuration } = await import('../../../src/config');
    return configuration.CONTEXT_COMPACTION_THRESHOLD_TOKENS;
  }

  it('is undefined when the env var is unset, leaving compaction to the context-length ratio', async () => {
    expect(await loadedThreshold(undefined)).toBeUndefined();
  });

  it('carries an explicit env value through unchanged', async () => {
    expect(await loadedThreshold('120000')).toBe(120_000);
  });
});
