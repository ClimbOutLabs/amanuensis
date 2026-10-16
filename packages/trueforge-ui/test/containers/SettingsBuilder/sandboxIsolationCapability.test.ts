// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { readSandboxLimits } from '@/containers/SettingsBuilder/sandboxIsolationCapability.js';

const wireShape = {
  sandbox_isolation: {
    isolation_driver: 'docker',
    image: 'ghcr.io/climboutlabs/amanuensis-sandbox:0.1.0@sha256:' + 'a'.repeat(64),
    default_timeout_seconds: 60,
    max_timeout_seconds: 600,
    memory_mb: 2048,
    disk_mb: 1024,
    stdout_stderr_cap_kb: 256,
    image_pull_timeout_seconds: 600,
    network_egress: false,
    cosign_key_configured: true,
  },
};

describe('readSandboxLimits', () => {
  it('reads the snake_case wire shape', () => {
    expect(readSandboxLimits(wireShape)).toEqual({
      image: wireShape.sandbox_isolation.image,
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
          image: 'img@sha256:' + 'b'.repeat(64),
          defaultTimeoutSeconds: 30,
          maxTimeoutSeconds: 300,
          memoryMb: 1024,
          diskMb: 512,
          networkEgress: false,
        },
      }),
    ).toMatchObject({ defaultTimeoutSeconds: 30, memoryMb: 1024, diskMb: 512 });
  });

  it('accepts an empty image, which is how a server without a sandbox image reports itself', () => {
    expect(readSandboxLimits({ sandbox_isolation: { ...wireShape.sandbox_isolation, image: '' } })).toMatchObject({
      image: '',
      memoryMb: 2048,
    });
  });

  it('returns null when the capability is missing or malformed', () => {
    expect(readSandboxLimits(null)).toBeNull();
    expect(readSandboxLimits({})).toBeNull();
    expect(readSandboxLimits({ sandboxIsolation: { image: 'img' } })).toBeNull();
    expect(readSandboxLimits({ sandboxIsolation: { ...wireShape.sandbox_isolation, memory_mb: -1 } })).toBeNull();
    expect(readSandboxLimits({ sandboxIsolation: { ...wireShape.sandbox_isolation, image: 3 } })).toBeNull();
  });
});
