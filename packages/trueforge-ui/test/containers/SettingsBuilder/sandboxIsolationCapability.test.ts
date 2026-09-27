// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { readSandboxIsolationStatus } from '@/containers/SettingsBuilder/sandboxIsolationCapability.js';

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

describe('readSandboxIsolationStatus', () => {
  it('reads the snake_case wire shape', () => {
    expect(readSandboxIsolationStatus(wireShape)).toEqual({
      isolationDriver: 'docker',
      image: wireShape.sandbox_isolation.image,
      defaultTimeoutSeconds: 60,
      maxTimeoutSeconds: 600,
      memoryMb: 2048,
      diskMb: 1024,
      stdoutStderrCapKb: 256,
      imagePullTimeoutSeconds: 600,
      networkEgress: false,
      cosignKeyConfigured: true,
    });
  });

  it('reads the SDK-normalized camelCase shape', () => {
    expect(
      readSandboxIsolationStatus({
        sandboxIsolation: {
          isolationDriver: 'firecracker',
          image: 'img@sha256:' + 'b'.repeat(64),
          defaultTimeoutSeconds: 30,
          maxTimeoutSeconds: 300,
          memoryMb: 1024,
          diskMb: 512,
          stdoutStderrCapKb: 128,
          imagePullTimeoutSeconds: 120,
          networkEgress: false,
          cosignKeyConfigured: false,
        },
      }),
    ).toMatchObject({ isolationDriver: 'firecracker', cosignKeyConfigured: false });
  });

  it('returns null when the capability is missing or malformed', () => {
    expect(readSandboxIsolationStatus(null)).toBeNull();
    expect(readSandboxIsolationStatus({})).toBeNull();
    expect(readSandboxIsolationStatus({ sandboxIsolation: { isolationDriver: 'docker' } })).toBeNull();
    expect(
      readSandboxIsolationStatus({
        sandboxIsolation: { ...wireShape.sandbox_isolation, isolation_driver: 'daytona' },
      }),
    ).toBeNull();
    expect(
      readSandboxIsolationStatus({
        sandboxIsolation: { ...wireShape.sandbox_isolation, memory_mb: -1 },
      }),
    ).toBeNull();
  });

  it('never exposes the cosign key path, only its presence', () => {
    const status = readSandboxIsolationStatus(wireShape);
    expect(status).not.toBeNull();
    expect(JSON.stringify(status)).not.toContain('cosign_public_key');
    expect(JSON.stringify(status)).not.toContain('.pub');
  });
});
