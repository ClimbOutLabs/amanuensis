// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { readSandboxLimits } from '@/containers/SettingsBuilder/sandboxIsolationCapability.js';

const wireShape = {
  sandbox_isolation: {
    default_timeout_seconds: 60,
    max_timeout_seconds: 600,
    memory_mb: 2048,
    disk_mb: 1024,
    stdout_stderr_cap_kb: 256,
    network_egress: false,
  },
};

describe('readSandboxLimits', () => {
  it('reads the snake_case wire shape', () => {
    expect(readSandboxLimits(wireShape)).toEqual({
      defaultTimeoutSeconds: 60,
      maxTimeoutSeconds: 600,
      memoryMb: 2048,
      diskMb: 1024,
      networkEgress: false,
    });
  });

  it('reads the SDK-normalized camelCase shape', () => {
    expect(
      readSandboxLimits({
        sandboxIsolation: {
          defaultTimeoutSeconds: 30,
          maxTimeoutSeconds: 300,
          memoryMb: 1024,
          diskMb: 512,
          networkEgress: false,
        },
      }),
    ).toMatchObject({ defaultTimeoutSeconds: 30, memoryMb: 1024, diskMb: 512 });
  });

  it('returns null when the capability is missing or malformed', () => {
    expect(readSandboxLimits(null)).toBeNull();
    expect(readSandboxLimits({})).toBeNull();
    expect(readSandboxLimits({ sandboxIsolation: { memoryMb: 1 } })).toBeNull();
    expect(readSandboxLimits({ sandboxIsolation: { ...wireShape.sandbox_isolation, memory_mb: -1 } })).toBeNull();
    expect(readSandboxLimits({ sandboxIsolation: { ...wireShape.sandbox_isolation, disk_mb: 'big' } })).toBeNull();
  });
});
