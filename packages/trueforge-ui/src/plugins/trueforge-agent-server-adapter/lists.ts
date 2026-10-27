/**
 * Configured-resource list helpers for composer pickers and host boot.
 * Not the settings catalog ports (`catalogs/*`).
 */
import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';

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
 * The build identity off a capabilities payload, or null when the host did not report one
 * or reported something unusable. The UI's capabilities type is narrower than the wire
 * shape, so this reads defensively rather than assuming the field is present.
 */
export function readBuildIdentity(capabilities: unknown): BuildIdentity | null {
  if (typeof capabilities !== 'object' || capabilities === null) {
    return null;
  }
  const build: unknown = Reflect.get(capabilities, 'build');
  if (typeof build !== 'object' || build === null) {
    return null;
  }
  const version: unknown = Reflect.get(build, 'version');
  if (typeof version !== 'string' || version.trim() === '') {
    return null;
  }
  const ref: unknown = Reflect.get(build, 'ref');
  return typeof ref === 'string' && ref.trim() !== '' ? { version, ref } : { version };
}

/**
 * The memory backend the server resolved (`MEMORY_BACKEND`), read defensively from the
 * `memory_defaults` capability. Undefined when the capability is missing, malformed, or
 * names an unknown backend — the caller then reports memory as unknown rather than guessing.
 */
export function readMemoryBackend(capabilities: unknown): 'markdown' | 'hindsight' | undefined {
  if (typeof capabilities !== 'object' || capabilities === null) {
    return undefined;
  }
  // The SDK normalizes wire keys to camelCase; a direct host adapter may expose the raw
  // snake_case payload instead.
  const defaults: unknown = Reflect.get(capabilities, 'memoryDefaults') ?? Reflect.get(capabilities, 'memory_defaults');
  if (typeof defaults !== 'object' || defaults === null) {
    return undefined;
  }
  const backend: unknown = Reflect.get(defaults, 'backend');
  return backend === 'markdown' || backend === 'hindsight' ? backend : undefined;
}
