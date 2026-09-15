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
 * The configured memory bank, or null when no connector carries the memory-provider flag.
 * `connected` is false while the connector waits on this user's sign-in, so a bank the user
 * cannot reach is reported as needing sign-in rather than as on.
 */
export async function getMemoryBankStatus(client: TrueForge): Promise<MemoryBankStatus | null> {
  // The settings surface, not the read catalog: only the settings manifest carries the flag.
  const listed = await client.settings.mcpServers.list();
  const provider = listed.data.find(
    server => server.manifest.type === 'remote' && server.manifest.memoryProvider === true,
  );
  if (provider === undefined) {
    return null;
  }
  return { name: provider.name, connected: provider.authStatus.status !== 'auth_required' };
}
