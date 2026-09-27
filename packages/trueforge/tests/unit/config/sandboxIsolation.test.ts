import configuration, { getRunCodeToolCallTimeoutMs, type ServerConfiguration } from '../../../src/config';

/**
 * Server-side parsing of the run_code isolation config. The module import
 * itself runs the fail-closed startup validation (pinned digest image +
 * cosign key required), so these tests also prove ordinary startup accepts
 * the .env.test dummies and rejects nothing valid.
 */
describe('sandbox isolation config', () => {
  it('defaults to the docker isolation driver', () => {
    expect(configuration.SANDBOX_ISOLATION_DRIVER).toBe('docker');
  });

  it('parses the plan defaults for run bounds', () => {
    expect(configuration.SANDBOX_DEFAULT_TIMEOUT_SECONDS).toBe(60);
    expect(configuration.SANDBOX_MAX_TIMEOUT_SECONDS).toBe(600);
    expect(configuration.SANDBOX_MEMORY_MB).toBe(2048);
    expect(configuration.SANDBOX_DISK_MB).toBe(1024);
    expect(configuration.SANDBOX_STDOUT_STDERR_CAP_KB).toBe(256);
    expect(configuration.SANDBOX_IMAGE_PULL_TIMEOUT_SECONDS).toBe(600);
  });

  it('keeps network egress reserved-off (v1 has no egress path)', () => {
    expect(configuration.SANDBOX_NETWORK_EGRESS).toBe(false);
  });

  it('E4: the normal tool-call timeout is back to 240 seconds', () => {
    expect(configuration.TOOL_CALL_TIMEOUT_MS).toBe(240_000);
  });

  it('E4: run_code gets its own derived dispatch deadline covering pull + max run + margin', () => {
    expect(getRunCodeToolCallTimeoutMs()).toBe(
      (configuration.SANDBOX_IMAGE_PULL_TIMEOUT_SECONDS + configuration.SANDBOX_MAX_TIMEOUT_SECONDS) * 1000 + 60_000,
    );
    expect(getRunCodeToolCallTimeoutMs()).toBeGreaterThan(configuration.TOOL_CALL_TIMEOUT_MS);
  });

  it('E4: the derived run_code deadline tracks custom sandbox bounds', () => {
    const config = {
      SANDBOX_IMAGE_PULL_TIMEOUT_SECONDS: 120,
      SANDBOX_MAX_TIMEOUT_SECONDS: 300,
    } as ServerConfiguration;
    expect(getRunCodeToolCallTimeoutMs(config)).toBe((120 + 300) * 1000 + 60_000);
  });

  it('U1: turn artifact retention defaults to 30 days', () => {
    expect(configuration.TURN_ARTIFACT_RETENTION_DAYS).toBe(30);
  });

  it('keeps the tool-call timeout below the server execution timeout', () => {
    expect(configuration.TOOL_CALL_TIMEOUT_MS).toBeLessThan(configuration.SERVER_EXECUTION_TIMEOUT_SECONDS * 1000);
  });

  it('exposes the firecracker stanza as config-only (not implemented)', () => {
    expect(configuration.SANDBOX_FIRECRACKER_KVM_DEVICE).toBe('/dev/kvm');
    expect(configuration.SANDBOX_FIRECRACKER_SNAPSHOT_ENABLED).toBe(false);
  });

  it('accepts the pinned-digest test image from .env.test', () => {
    expect(configuration.SANDBOX_IMAGE).toMatch(/^.+@sha256:[0-9a-f]{64}$/);
    expect(configuration.SANDBOX_COSIGN_PUBLIC_KEY_PATH.trim()).not.toBe('');
  });
});
