import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { IAgentStore } from '../db/agentStore';
import type { IMcpServerStore } from '../db/mcpServerStore';
import type { IPersonaStore } from '../db/personaStore';
import type { IPersonalizationStore } from '../db/personalizationStore';
import type { IScheduleStore } from '../db/scheduleStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import type { ISpaceStore } from '../db/spaceStore';
import { vaultFilesystemNamespace } from '../runtime/memory/markdownMemoryFiles';
import type { MemoryClient } from '../runtime/memory/memoryClient';
import { DataImportError } from './importError';

export type MemoryImportTarget = { kind: 'markdown'; markdownDir: string } | { kind: 'client'; client: MemoryClient };

export interface PreflightDeps<TTransaction> {
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  personaStore: IPersonaStore<TTransaction>;
  personalizationStore: IPersonalizationStore<TTransaction>;
  spaceStore: ISpaceStore<TTransaction>;
  scheduleStore: IScheduleStore<TTransaction>;
  mcpServerStore: IMcpServerStore<TTransaction>;
  agentStore: IAgentStore<TTransaction>;
  memoryTarget: MemoryImportTarget;
}

const MEMORY_LIST_TIMEOUT_MS = 120_000;
const MAX_LISTED_COLLISIONS = 5;

/** "a, b and c" */
function joinPlain(items: readonly string[]): string {
  if (items.length <= 1) {
    return items.join('');
  }
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/** Whether the personalization profile still holds only its defaults, as when the app created it on first sign-in. */
function isPristineProfile(profile: {
  assistant_name: string | null;
  assistant_identity: string | null;
  voice_guidance: string | null;
  user_profile: string | null;
  pinned_preferences: readonly string[];
  learned_profile: string | null;
}): boolean {
  return (
    profile.assistant_name === null &&
    profile.assistant_identity === null &&
    profile.voice_guidance === null &&
    profile.user_profile === null &&
    profile.learned_profile === null &&
    profile.pinned_preferences.length === 0
  );
}

/** True when the target tenant's Markdown vault already holds any memory content. */
async function markdownMemoryHasContent(markdownDir: string, tenantId: string): Promise<boolean> {
  if (!existsSync(markdownDir)) {
    return false;
  }
  const tenantSeg = vaultFilesystemNamespace(tenantId, undefined);
  const dirNames = (await readdir(markdownDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => name === tenantSeg || name.startsWith(`${tenantSeg}__`));
  for (const dirName of dirNames) {
    const dirPath = path.join(markdownDir, dirName);
    const memoryMd = path.join(dirPath, 'MEMORY.md');
    if (existsSync(memoryMd) && (await readFile(memoryMd, 'utf8')).trim().length > 0) {
      return true;
    }
    if (existsSync(path.join(dirPath, '.vault-tombstones.md'))) {
      return true;
    }
    const dailyDir = path.join(dirPath, 'memory');
    if (existsSync(dailyDir)) {
      const dailyFiles = (await readdir(dailyDir, { withFileTypes: true })).filter(
        entry => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name),
      );
      if (dailyFiles.length > 0) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Refuses unless the instance is fresh, naming every kind of data it already
 * holds. A personalization profile the app created on first sign-in (nothing
 * filled in) does not count; the import replaces it. Global and permission
 * settings do not count either: the import only fills settings the instance
 * has not set.
 */
export async function assertInstanceEmpty<TTransaction>(
  deps: PreflightDeps<TTransaction>,
  input: {
    tenantId: string;
    subjectId: string;
    scope: { created_by_subject_id: string; agent_ids: readonly string[] };
  },
): Promise<void> {
  const { tenantId, subjectId, scope } = input;
  const found: string[] = [];

  const sessionPage = await deps.sessionStore.listSessions({
    tenant_id: tenantId,
    limit: 1,
    page_token: undefined,
    order: 'asc',
    start_timestamp: undefined,
    end_timestamp: undefined,
    agent_id: undefined,
    created_by_or_agent_ids: scope,
    metadata: undefined,
    source_type: undefined,
    source_id: undefined,
  });
  if (sessionPage.data.length > 0) {
    found.push('chats');
  }
  if ((await deps.sessionStore.listSessionFolders({ tenant_id: tenantId, created_by: subjectId })).length > 0) {
    found.push('folders');
  }
  if ((await deps.personaStore.listPersonas({ tenant_id: tenantId, created_by: subjectId })).length > 0) {
    found.push('personas');
  }
  const profile = await deps.personalizationStore.getProfile({ tenant_id: tenantId, created_by: subjectId });
  if (profile !== undefined && !isPristineProfile(profile)) {
    found.push('a personalization profile');
  }
  const spaceList = await deps.spaceStore.listSpaces({
    tenant_id: tenantId,
    created_by: subjectId,
    status: undefined,
    limit: 1,
    offset: 0,
  });
  if (spaceList.length > 0) {
    found.push('spaces');
  }
  const schedulePage = await deps.scheduleStore.listSchedules({
    tenant_id: tenantId,
    limit: 1,
    page_token: undefined,
    agent_names: undefined,
    created_by_or_agent_ids: scope,
  });
  if (schedulePage.data.length > 0) {
    found.push('schedules');
  }
  const agentPage = await deps.agentStore.listAgents({
    tenant_id: tenantId,
    agent_name: undefined,
    limit: 1,
    page_token: undefined,
  });
  if (agentPage.data.length > 0) {
    found.push('agents');
  }
  if ((await deps.mcpServerStore.listServers({ tenant_id: tenantId, names: undefined })).length > 0) {
    found.push('connectors');
  }
  if (deps.memoryTarget.kind === 'markdown') {
    if (await markdownMemoryHasContent(deps.memoryTarget.markdownDir, tenantId)) {
      found.push('memories');
    }
  } else {
    const outcome = await deps.memoryTarget.client.listEntries({ namespace: '', timeoutMs: MEMORY_LIST_TIMEOUT_MS });
    if (!outcome.ok) {
      throw new DataImportError('The memory store could not be read, so the import cannot run.', 500);
    }
    if (outcome.entries.length > 0) {
      found.push('memories');
    }
  }

  if (found.length > 0) {
    throw new DataImportError(
      `This instance already has ${joinPlain(found)}, so the import was refused and nothing was changed. ` +
        'Data imports only run into a fresh instance: remove this instance, create it again, then import.',
      409,
    );
  }
}

export interface ArchiveIds {
  sessionIds: readonly string[];
  folderIds: readonly string[];
  personas: readonly { id: string }[];
  spaceIds: readonly string[];
  scheduleIds: readonly string[];
  agents: readonly { id: string; name: string }[];
}

/**
 * Refuses when any id or name the archive would create already exists. This
 * is what lets compensation delete by id: nothing it deletes was there first.
 * Names the colliding items instead of surfacing a store conflict later.
 */
export async function assertNoIdCollisions<TTransaction>(
  deps: PreflightDeps<TTransaction>,
  input: { tenantId: string; subjectId: string; ids: ArchiveIds },
): Promise<void> {
  const { tenantId, subjectId, ids } = input;
  const collisions: string[] = [];

  for (const sessionId of ids.sessionIds) {
    if ((await deps.sessionStore.getSession({ tenant_id: tenantId, session_id: sessionId })) !== undefined) {
      collisions.push(`chat ${sessionId}`);
    }
  }
  for (const folderId of ids.folderIds) {
    const folder = await deps.sessionStore.getSessionFolder({
      tenant_id: tenantId,
      folder_id: folderId,
      created_by: subjectId,
    });
    if (folder !== undefined) {
      collisions.push(`folder ${folderId}`);
    }
  }
  for (const persona of ids.personas) {
    if (
      (await deps.personaStore.getPersona({ tenant_id: tenantId, created_by: subjectId, id: persona.id })) !== undefined
    ) {
      collisions.push(`persona ${persona.id}`);
    }
  }
  for (const spaceId of ids.spaceIds) {
    if (
      (await deps.spaceStore.getSpace({ tenant_id: tenantId, created_by: subjectId, space_id: spaceId })) !== undefined
    ) {
      collisions.push(`space ${spaceId}`);
    }
  }
  for (const scheduleId of ids.scheduleIds) {
    if ((await deps.scheduleStore.getSchedule({ tenant_id: tenantId, id: scheduleId })) !== undefined) {
      collisions.push(`schedule ${scheduleId}`);
    }
  }
  for (const agent of ids.agents) {
    const byId = await deps.agentStore.getAgent({ tenant_id: tenantId, id: agent.id });
    const byName = await deps.agentStore.getAgent({ tenant_id: tenantId, name: agent.name });
    if (byId !== undefined || byName !== undefined) {
      collisions.push(`agent ${agent.name}`);
    }
  }

  if (collisions.length > 0) {
    const listed = collisions.slice(0, MAX_LISTED_COLLISIONS).join(', ');
    const more =
      collisions.length > MAX_LISTED_COLLISIONS ? ` and ${String(collisions.length - MAX_LISTED_COLLISIONS)} more` : '';
    throw new DataImportError(
      `This instance already has items with the same ids as the export (${listed}${more}), so the import was refused and nothing was changed.`,
      409,
    );
  }
}
