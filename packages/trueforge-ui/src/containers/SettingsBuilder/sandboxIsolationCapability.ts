/**
 * The run_code sandbox's configured limits, from the `sandbox_isolation` capability the server adds
 * to `GET /api/v1/capabilities` (see `SandboxIsolationCapability` in
 * `packages/trueforge/src/schemas/capability.ts`). The generated SDK normalizes the wire keys
 * to camelCase before the UI receives them; the snake_case fallback keeps direct host adapters
 * that expose the raw payload working.
 *
 * Never throws: anything short of the complete, well-typed set reads as `null`, so the page shows
 * no limits rather than wrong ones.
 */
import { isObject } from './memoryScreenCapability.js';

export interface SandboxLimits {
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  memoryMb: number;
  diskMb: number;
  networkEgress: boolean;
}

/** Reads the SDK-normalized key, falling back to the raw wire key a direct host adapter exposes. */
function read({ raw, camel, snake }: { raw: object; camel: string; snake: string }): unknown {
  const value = Reflect.get(raw, camel);
  return value === undefined ? Reflect.get(raw, snake) : value;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function readSandboxLimits(capabilities: unknown): SandboxLimits | null {
  if (!isObject(capabilities)) return null;
  const raw = read({ raw: capabilities, camel: 'sandboxIsolation', snake: 'sandbox_isolation' });
  if (!isObject(raw)) return null;
  const defaultTimeoutSeconds = nonNegativeInt(
    read({ raw, camel: 'defaultTimeoutSeconds', snake: 'default_timeout_seconds' }),
  );
  const maxTimeoutSeconds = nonNegativeInt(read({ raw, camel: 'maxTimeoutSeconds', snake: 'max_timeout_seconds' }));
  const memoryMb = nonNegativeInt(read({ raw, camel: 'memoryMb', snake: 'memory_mb' }));
  const diskMb = nonNegativeInt(read({ raw, camel: 'diskMb', snake: 'disk_mb' }));
  const networkEgress = read({ raw, camel: 'networkEgress', snake: 'network_egress' });
  if (
    defaultTimeoutSeconds === null ||
    maxTimeoutSeconds === null ||
    memoryMb === null ||
    diskMb === null ||
    typeof networkEgress !== 'boolean'
  ) {
    return null;
  }
  return { defaultTimeoutSeconds, maxTimeoutSeconds, memoryMb, diskMb, networkEgress };
}
