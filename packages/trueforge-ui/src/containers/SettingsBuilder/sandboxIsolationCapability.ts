/**
 * Live run_code isolation-driver status, from the `sandbox_isolation` capability the server adds to
 * `GET /api/v1/capabilities` (see `SandboxIsolationCapability` in
 * `packages/trueforge/src/schemas/capability.ts`). The generated SDK normalizes the wire keys
 * to camelCase before the UI receives them; the snake_case fallback keeps direct host adapters
 * that expose the raw payload working.
 *
 * Never throws: anything short of the complete, well-typed set reads as `null`, and the section
 * then says the status is unavailable rather than showing a wrong one. The cosign key path is
 * never exposed — only whether a key is configured.
 */
import { isObject } from './memoryScreenCapability.js';

export interface SandboxIsolationStatus {
  isolationDriver: 'docker' | 'firecracker';
  image: string;
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  memoryMb: number;
  diskMb: number;
  stdoutStderrCapKb: number;
  imagePullTimeoutSeconds: number;
  networkEgress: boolean;
  cosignKeyConfigured: boolean;
}

/** Reads the SDK-normalized key, falling back to the raw wire key a direct host adapter exposes. */
function read({ raw, camel, snake }: { raw: object; camel: string; snake: string }): unknown {
  const value = Reflect.get(raw, camel);
  return value === undefined ? Reflect.get(raw, snake) : value;
}

function isolationDriver(value: unknown): 'docker' | 'firecracker' | null {
  switch (value) {
    case 'docker':
    case 'firecracker':
      return value;
    default:
      return null;
  }
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function readSandboxIsolationStatus(capabilities: unknown): SandboxIsolationStatus | null {
  if (!isObject(capabilities)) return null;
  const raw = read({ raw: capabilities, camel: 'sandboxIsolation', snake: 'sandbox_isolation' });
  if (!isObject(raw)) return null;
  const driver = isolationDriver(read({ raw, camel: 'isolationDriver', snake: 'isolation_driver' }));
  const image = read({ raw, camel: 'image', snake: 'image' });
  const defaultTimeoutSeconds = nonNegativeInt(
    read({ raw, camel: 'defaultTimeoutSeconds', snake: 'default_timeout_seconds' }),
  );
  const maxTimeoutSeconds = nonNegativeInt(read({ raw, camel: 'maxTimeoutSeconds', snake: 'max_timeout_seconds' }));
  const memoryMb = nonNegativeInt(read({ raw, camel: 'memoryMb', snake: 'memory_mb' }));
  const diskMb = nonNegativeInt(read({ raw, camel: 'diskMb', snake: 'disk_mb' }));
  const stdoutStderrCapKb = nonNegativeInt(read({ raw, camel: 'stdoutStderrCapKb', snake: 'stdout_stderr_cap_kb' }));
  const imagePullTimeoutSeconds = nonNegativeInt(
    read({ raw, camel: 'imagePullTimeoutSeconds', snake: 'image_pull_timeout_seconds' }),
  );
  const networkEgress = read({ raw, camel: 'networkEgress', snake: 'network_egress' });
  const cosignKeyConfigured = read({ raw, camel: 'cosignKeyConfigured', snake: 'cosign_key_configured' });
  if (
    driver === null ||
    typeof image !== 'string' ||
    image.length === 0 ||
    defaultTimeoutSeconds === null ||
    maxTimeoutSeconds === null ||
    memoryMb === null ||
    diskMb === null ||
    stdoutStderrCapKb === null ||
    imagePullTimeoutSeconds === null ||
    typeof networkEgress !== 'boolean' ||
    typeof cosignKeyConfigured !== 'boolean'
  ) {
    return null;
  }
  return {
    isolationDriver: driver,
    image,
    defaultTimeoutSeconds,
    maxTimeoutSeconds,
    memoryMb,
    diskMb,
    stdoutStderrCapKb,
    imagePullTimeoutSeconds,
    networkEgress,
    cosignKeyConfigured,
  };
}
