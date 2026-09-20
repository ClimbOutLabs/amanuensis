/**
 * Read-only status of memory-adjacent content screens, from the `memory_screen` and
 * `tool_output_screen` capabilities the server adds to `GET /api/v1/capabilities` (see
 * `packages/trueforge/src/schemas/capability.ts`). The generated SDK normalizes snake_case wire
 * keys before the UI receives them; `configured` and `reason` are read defensively with
 * `Reflect.get` rather than through the generated `MemoryScreenCapability` /
 * `ToolOutputScreenCapability` types, which do not yet declare them (they landed on the server
 * first).
 *
 * The screen classifies recalled memory as it would be injected into the model's context — the
 * structural defense against a note the host retained getting recalled into an unrelated chat and
 * hijacking the reply. The classifier sidecar itself is configured entirely through
 * `MEMORY_SCREEN_*` environment variables; whether it actually runs is the per-bank
 * `screen_enabled` setting in Settings > Memory, which `MemorySettings` writes through the memory
 * bank's `memorySettings`. This module only reads the effective status, the same way it reads the
 * memory bank.
 */

import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

/** True for anything `Reflect.get` can be called on without throwing. */
export function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function enabledOf(raw: unknown): boolean | null {
  if (!isObject(raw)) return null;
  const enabled = Reflect.get(raw, 'enabled');
  if (typeof enabled !== 'boolean') return null;
  return enabled;
}

function numberFieldOf(raw: object, field: string): number | undefined {
  const value = Reflect.get(raw, field);
  return typeof value === 'number' ? value : undefined;
}

function stringFieldOf(raw: object, field: string): string | undefined {
  const value = Reflect.get(raw, field);
  return typeof value === 'string' ? value : undefined;
}

function booleanFieldOf(raw: object, field: string): boolean | undefined {
  const value = Reflect.get(raw, field);
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * `MemoryScreenCapability` widened with the fields the generated SDK does not yet declare.
 * `configured` defaults to true when a server predates the field, so an old build's switch is
 * never wrongly shown disabled.
 */
export type MemoryScreenStatus = TrueForgeApi.MemoryScreenCapability & {
  configured: boolean;
  reason?: string;
};

export function readMemoryScreenStatus(capabilities: unknown): MemoryScreenStatus | null {
  if (!isObject(capabilities)) return null;
  const normalized = Reflect.get(capabilities, 'memoryScreen');
  const raw = normalized ?? Reflect.get(capabilities, 'memory_screen');
  const enabled = enabledOf(raw);
  if (enabled === null || !isObject(raw)) return null;
  const threshold = numberFieldOf(raw, 'threshold');
  const reason = stringFieldOf(raw, 'reason');
  return {
    enabled,
    configured: booleanFieldOf(raw, 'configured') ?? true,
    ...(reason !== undefined ? { reason } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
  };
}

/**
 * `ToolOutputScreenCapability` widened with the fields the generated SDK does not yet declare.
 * `configured` defaults to true when a server predates the field, so an old build's switch is
 * never wrongly shown disabled.
 */
export type ToolOutputScreenStatus = TrueForgeApi.ToolOutputScreenCapability & {
  configured: boolean;
  reason?: string;
};

export function readToolOutputScreenStatus(capabilities: unknown): ToolOutputScreenStatus | null {
  if (!isObject(capabilities)) return null;
  const normalized = Reflect.get(capabilities, 'toolOutputScreen');
  const raw = normalized ?? Reflect.get(capabilities, 'tool_output_screen');
  const enabled = enabledOf(raw);
  if (enabled === null || !isObject(raw)) return null;
  const threshold = numberFieldOf(raw, 'threshold');
  const timeoutMs = numberFieldOf(raw, 'timeoutMs') ?? numberFieldOf(raw, 'timeout_ms');
  const reason = stringFieldOf(raw, 'reason');
  return {
    enabled,
    configured: booleanFieldOf(raw, 'configured') ?? true,
    ...(reason !== undefined ? { reason } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}
