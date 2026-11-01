import { personaVaultNamespace } from '../../runtime/memory/markdownMemoryFiles';
import { SPACE_LIST_LIMIT } from '../../schemas/space';
import type { DemoSeedScope, DemoSeedStores } from './seed';

const PAGE_SIZE = 100;
const MEMORY_TIMEOUT_MS = 10_000;
const SHARED_VAULT = 'default';

export interface FreshReport {
  sessions: number;
  folders: number;
  schedules: number;
  spaces: number;
  memory: number;
  personas: number;
  profile: number;
}

async function removeSchedules<TTransaction>({
  stores,
  scope,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
}): Promise<number> {
  let removed = 0;
  for (;;) {
    const { data } = await stores.scheduleStore.listSchedules({
      tenant_id: scope.tenantId,
      limit: PAGE_SIZE,
      page_token: undefined,
      agent_names: undefined,
      created_by_or_agent_ids: { created_by_subject_id: scope.userId, agent_ids: [] },
    });
    if (data.length === 0) {
      return removed;
    }
    for (const schedule of data) {
      await stores.scheduleStore.deleteSchedule({ tenant_id: scope.tenantId, id: schedule.id });
      removed += 1;
    }
  }
}

/** Chat deletion does not reach the saved files, so each chat's files go first. */
async function removeSessions<TTransaction>({
  stores,
  scope,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
}): Promise<number> {
  let removed = 0;
  for (;;) {
    const { data } = await stores.sessionStore.listSessions({
      tenant_id: scope.tenantId,
      limit: PAGE_SIZE,
      page_token: undefined,
      order: undefined,
      start_timestamp: undefined,
      end_timestamp: undefined,
      agent_id: undefined,
      created_by_or_agent_ids: { created_by_subject_id: scope.userId, agent_ids: [] },
      metadata: undefined,
      source_type: undefined,
      source_id: undefined,
      folder_id: undefined,
      no_folder: false,
    });
    if (data.length === 0) {
      return removed;
    }
    for (const session of data) {
      await stores.turnArtifactStore.deleteArtifactsForSession({
        tenant_id: scope.tenantId,
        session_id: session.session_id,
      });
      await stores.sessionStore.deleteSession({ tenant_id: scope.tenantId, session_id: session.session_id });
      removed += 1;
    }
  }
}

async function removeFolders<TTransaction>({
  stores,
  scope,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
}): Promise<number> {
  const folders = await stores.sessionStore.listSessionFolders({ tenant_id: scope.tenantId, created_by: scope.userId });
  for (const folder of folders) {
    await stores.sessionStore.deleteSessionFolder({
      tenant_id: scope.tenantId,
      folder_id: folder.folder_id,
      created_by: scope.userId,
    });
  }
  return folders.length;
}

async function removeSpaces<TTransaction>({
  stores,
  scope,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
}): Promise<number> {
  const owner = { tenant_id: scope.tenantId, created_by: scope.userId };
  let removed = 0;
  for (;;) {
    const spaces = await stores.spaceStore.listSpaces({ ...owner, status: undefined, limit: SPACE_LIST_LIMIT });
    if (spaces.length === 0) {
      return removed;
    }
    for (const space of spaces) {
      await stores.spaceStore.deleteSpace({ ...owner, space_id: space.id, expected_revision: space.revision });
      removed += 1;
    }
  }
}

/**
 * Empties the shared vault and the vault of each given persona. Memory has no owner field, so this is the
 * whole tenant's memory: it is only safe because the command refuses to run outside demo mode.
 */
async function removeMemory<TTransaction>({
  stores,
  personaNames,
}: {
  stores: DemoSeedStores<TTransaction>;
  personaNames: readonly string[];
}): Promise<number> {
  let removed = 0;
  for (const namespace of [SHARED_VAULT, ...personaNames.map(personaVaultNamespace)]) {
    const listed = await stores.memory.listEntries({ namespace, timeoutMs: MEMORY_TIMEOUT_MS });
    if (!listed.ok) {
      throw new Error(`Could not read the memory vault "${namespace}": ${listed.reason}`);
    }
    for (const entry of listed.entries) {
      const deleted = await stores.memory.deleteEntry({ entryId: entry.id, timeoutMs: MEMORY_TIMEOUT_MS });
      if (!deleted.ok) {
        throw new Error(`Could not remove a memory note from "${namespace}": ${deleted.reason}`);
      }
      removed += 1;
    }
  }
  return removed;
}

/**
 * Removes everything this user made through each store's own delete path, so the normal seed can refill an
 * instance that looks like a first run. Other users' records, and agents (shared by name), are left alone.
 */
export async function wipeUserData<TTransaction>({
  stores,
  scope,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
}): Promise<FreshReport> {
  const owner = { tenant_id: scope.tenantId, created_by: scope.userId };
  const schedules = await removeSchedules({ stores, scope });
  const sessions = await removeSessions({ stores, scope });
  const folders = await removeFolders({ stores, scope });
  const spaces = await removeSpaces({ stores, scope });

  const personas = await stores.personaStore.listPersonas(owner);
  const memory = await removeMemory({ stores, personaNames: personas.map(persona => persona.display_name) });
  for (const persona of personas) {
    await stores.personaStore.deletePersona({ ...owner, id: persona.id });
    await stores.knowledge.deleteLibrary({ personaId: persona.id });
  }

  const hadProfile = (await stores.personalizationStore.getProfile(owner)) !== undefined;
  await stores.personalizationStore.deleteProfile(owner);

  return {
    sessions,
    folders,
    schedules,
    spaces,
    memory,
    personas: personas.length,
    profile: hadProfile ? 1 : 0,
  };
}
