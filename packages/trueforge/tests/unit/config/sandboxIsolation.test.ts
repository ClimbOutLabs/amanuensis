import configuration, { getRunCodeToolCallTimeoutMs } from '../../../src/config';

/**
 * Server-side parsing of the run_code limits. The module import itself runs the
 * fail-closed startup validation, so these tests also prove ordinary startup
 * accepts the .env.test values and rejects nothing valid.
 */
describe('sandbox isolation config', () => {
  it('parses the plan defaults for run bounds', () => {
    expect(configuration.SANDBOX_DEFAULT_TIMEOUT_SECONDS).toBe(60);
    expect(configuration.SANDBOX_MAX_TIMEOUT_SECONDS).toBe(600);
    expect(configuration.SANDBOX_MEMORY_MB).toBe(2048);
    expect(configuration.SANDBOX_DISK_MB).toBe(1024);
    expect(configuration.SANDBOX_STDOUT_STDERR_CAP_KB).toBe(256);
  });

  it('keeps network egress reserved-off (v1 has no egress path)', () => {
    expect(configuration.SANDBOX_NETWORK_EGRESS).toBe(false);
  });

  it('E4: the normal tool-call timeout is back to 240 seconds', () => {
    expect(configuration.TOOL_CALL_TIMEOUT_MS).toBe(240_000);
  });

  it('E4: run_code gets its own derived dispatch deadline covering the max run + margin', () => {
    expect(getRunCodeToolCallTimeoutMs()).toBe(configuration.SANDBOX_MAX_TIMEOUT_SECONDS * 1000 + 60_000);
    expect(getRunCodeToolCallTimeoutMs()).toBeGreaterThan(configuration.TOOL_CALL_TIMEOUT_MS);
  });

  it('E4: the derived run_code deadline tracks custom sandbox bounds', () => {
    const config = { ...configuration, SANDBOX_MAX_TIMEOUT_SECONDS: 300 };
    expect(getRunCodeToolCallTimeoutMs(config)).toBe(300 * 1000 + 60_000);
  });

  it('U1: turn artifact retention defaults to 30 days', () => {
    expect(configuration.TURN_ARTIFACT_RETENTION_DAYS).toBe(30);
  });

  it('keeps the tool-call timeout below the server execution timeout', () => {
    expect(configuration.TOOL_CALL_TIMEOUT_MS).toBeLessThan(configuration.SERVER_EXECUTION_TIMEOUT_SECONDS * 1000);
  });
});
