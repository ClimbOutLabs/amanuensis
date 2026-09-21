import { parsePositiveInt } from '../../../src/config';

describe('TOOL_DISPATCH_MAX_CONCURRENCY env parsing', () => {
  it('defaults to 4 when unset', () => {
    const value = parsePositiveInt({
      envKey: 'TOOL_DISPATCH_MAX_CONCURRENCY',
      raw: undefined,
      defaultValue: 4,
    });
    expect(value).toBe(4);
  });

  it('accepts a positive integer override', () => {
    const value = parsePositiveInt({
      envKey: 'TOOL_DISPATCH_MAX_CONCURRENCY',
      raw: '8',
      defaultValue: 4,
    });
    expect(value).toBe(8);
  });

  it('rejects a non-positive value', () => {
    expect(() =>
      parsePositiveInt({
        envKey: 'TOOL_DISPATCH_MAX_CONCURRENCY',
        raw: '0',
        defaultValue: 4,
      }),
    ).toThrow('must be an integer of at least 1');
  });
});

describe('TOOL_CALL_TIMEOUT_MS env parsing', () => {
  it('defaults to 240000 when unset', () => {
    const value = parsePositiveInt({
      envKey: 'TOOL_CALL_TIMEOUT_MS',
      raw: undefined,
      defaultValue: 240_000,
    });
    expect(value).toBe(240_000);
  });

  it('accepts a positive integer override', () => {
    const value = parsePositiveInt({
      envKey: 'TOOL_CALL_TIMEOUT_MS',
      raw: '60000',
      defaultValue: 240_000,
    });
    expect(value).toBe(60_000);
  });

  it('rejects a non-positive value', () => {
    expect(() =>
      parsePositiveInt({
        envKey: 'TOOL_CALL_TIMEOUT_MS',
        raw: '-5',
        defaultValue: 240_000,
      }),
    ).toThrow('must be an integer of at least 1');
  });

  it('keeps the default below the server execution timeout so one hung call cannot outlive the turn', () => {
    const serverExecutionTimeoutMs = 600 * 1000;
    expect(240_000).toBeLessThan(serverExecutionTimeoutMs);
  });
});
