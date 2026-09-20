/**
 * Configured-resource list helpers for composer pickers and host boot.
 * Not the settings catalog ports (`catalogs/*`).
 */
import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { MemoryBankStatus } from '../../components/AmanSetupContext.js';

export async function listModels(client: TrueForge): Promise<TrueForgeApi.AvailableModel[]> {
  const body = await client.models.list();
  return body.data;
}

export async function listConfiguredMcpServers(client: TrueForge): Promise<TrueForgeApi.AvailableMcpServer[]> {
  const body = await client.mcpServers.list();
  return body.data;
}

export async function listSkills(client: TrueForge): Promise<TrueForgeApi.AvailableSkill[]> {
  const body = await client.skills.list();
  return body.data;
}

/**
 * The running server's build identity (package version plus the source reference its image was
 * stamped with), aliased from the generated SDK so there is one canonical owner of the wire shape.
 */
export type BuildIdentity = TrueForgeApi.BuildIdentity;

/**
 * The generated SDK's `CapabilitiesData` now declares `build: BuildIdentity`, so callers read it off
 * the canonical type directly rather than a locally widened copy.
 */
export async function getCapabilities(client: TrueForge): Promise<TrueForgeApi.CapabilitiesData> {
  const body = await client.server.getCapabilities();
  return body.data;
}

/**
 * The status name the rail and welcome screen show for each server-side memory backend.
 * Matches the Settings › Memory status card so the two surfaces agree.
 */
const MEMORY_BACKEND_STATUS_NAME = {
  markdown: 'Markdown (local files)',
  hindsight: 'Hindsight (experimental)',
} as const;

/**
 * The memory backend the server resolved (`MEMORY_BACKEND`), read defensively from the
 * `memory_defaults` capability. Undefined when the capability is missing, malformed, or
 * names an unknown backend — the caller then reports memory as unknown rather than guessing.
 */
export function readMemoryBackend(
  capabilities: unknown,
): keyof typeof MEMORY_BACKEND_STATUS_NAME | undefined {
  if (typeof capabilities !== 'object' || capabilities === null) {
    return undefined;
  }
  // The SDK normalizes wire keys to camelCase; a direct host adapter may expose the raw
  // snake_case payload instead.
  const defaults: unknown =
    Reflect.get(capabilities, 'memoryDefaults') ?? Reflect.get(capabilities, 'memory_defaults');
  if (typeof defaults !== 'object' || defaults === null) {
    return undefined;
  }
  const backend: unknown = Reflect.get(defaults, 'backend');
  return backend === 'markdown' || backend === 'hindsight' ? backend : undefined;
}

/**
 * The memory status the welcome screen and runtime rail report, read from the server's
 * `memory_defaults` capability (`MEMORY_BACKEND` as resolved). Markdown and Hindsight are
 * both server-side backends with nothing to connect, so naming one means memory reads as
 * on — there is no bank to connect and no sign-in to wait on.
 *
 * Null when the capability is missing or names an unknown backend: the screens then say
 * nothing about memory rather than guessing. A failed capabilities read throws, and the
 * host treats that as "unknown" rather than as off.
 */
export async function getMemoryBankStatus(client: TrueForge): Promise<MemoryBankStatus | null> {
  const capabilities = await client.server.getCapabilities();
  const backend = readMemoryBackend(capabilities.data);
  if (backend === undefined) {
    return null;
  }
  return { name: MEMORY_BACKEND_STATUS_NAME[backend], connected: true };
}
