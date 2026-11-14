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

export type SignInMode = 'local' | 'oidc' | 'standalone' | 'truefoundry';

/**
 * The sign-in mode the server reported, read defensively from the `sign_in` capability.
 * Undefined when the capability is missing, malformed, or names an unknown mode, so callers
 * show nothing rather than guessing. The SDK normalizes wire keys to camelCase; a direct
 * host adapter may expose the raw snake_case payload instead.
 */
export function readSignInMode(capabilities: unknown): SignInMode | undefined {
  if (typeof capabilities !== 'object' || capabilities === null) {
    return undefined;
  }
  const signIn: unknown = Reflect.get(capabilities, 'signIn') ?? Reflect.get(capabilities, 'sign_in');
  if (typeof signIn !== 'object' || signIn === null) {
    return undefined;
  }
  const mode: unknown = Reflect.get(signIn, 'mode');
  return mode === 'local' || mode === 'oidc' || mode === 'standalone' || mode === 'truefoundry' ? mode : undefined;
}

/**
 * Whether the server reported its memory status (the `memory_defaults` capability). False when the
 * capability is missing or malformed: the caller then says memory is unknown and does not guess.
 */
export function memoryStatusReported(capabilities: unknown): boolean {
  if (typeof capabilities !== 'object' || capabilities === null) {
    return false;
  }
  // The SDK normalizes wire keys to camelCase; a direct host adapter may expose the raw
  // snake_case payload instead.
  const defaults: unknown = Reflect.get(capabilities, 'memoryDefaults') ?? Reflect.get(capabilities, 'memory_defaults');
  return typeof defaults === 'object' && defaults !== null;
}
