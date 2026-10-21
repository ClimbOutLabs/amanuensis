import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { isUntouchedDefaultSearchConnector } from '../catalog/defaultSearchConnector';
import type { McpCatalog } from '../catalog/McpCatalog';
import type { IAgentStore } from '../db/agentStore';
import type { IMcpServerStore, McpServerRecord } from '../db/mcpServerStore';
import type { IPersonalizationStore } from '../db/personalizationStore';
import type { IPersonaStore } from '../db/personaStore';
import type { IScheduleStore } from '../db/scheduleStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import type { ISpaceStore } from '../db/spaceStore';
import {
  CURATED_MEMORY_FILE,
  DAILY_LOG_FILE_PATTERN,
  VAULT_TOMBSTONES_FILE,
  vaultFilesystemNamespace,
} from '../runtime/memory/markdownMemoryFiles';
import type { MemoryClient } from '../runtime/memory/memoryClient';
import { DataImportError } from './importError';
import { emptyLedger, type ImportLedger } from './importLedger';

export type MemoryImportTarget =
  { kind: 'markdown'; markdownDir: string } | { kind: 'client'; client: Pick<MemoryClient, 'listEntries' | 'retain'> };

export interface PreflightDeps<TTransaction> {
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  personaStore: IPersonaStore<TTransaction>;
  personalizationStore: IPersonalizationStore<TTransaction>;
  spaceStore: ISpaceStore<TTransaction>;
  scheduleStore: IScheduleStore<TTransaction>;
  mcpServerStore: IMcpServerStore<TTransaction>;
  agentStore: IAgentStore<TTransaction>;
  /** Tells the web search connector every new instance is given apart from the owner's own. */
  mcpCatalog: McpCatalog;
  memoryTarget: MemoryImportTarget;
  /** The name the installer gave the owner, '' when none; a profile holding only that name still counts as fresh. */
  ownerName: string;
}

const MEMORY_LIST_TIMEOUT_MS = 120_000;
const PAGE_SIZE = 100;
const MAX_LISTED_COLLISIONS = 5;

/** "a, b and c" */
function joinPlain(items: readonly string[]): string {
  if (items.length <= 1) {
    return items.join('');
  }
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/**
 * Whether the personalization profile still holds only its defaults, as when the app created it on first sign-in,
 * apart from the installer's name for the owner, which the app fills in at boot.
 */
function isPristineProfile({
  profile,
  ownerName,
}: {
  profile: {
    assistant_name: string | null;
    assistant_identity: string | null;
    voice_guidance: string | null;
    user_name: string | null;
    address_as: string | null;
    user_profile: string | null;
    pinned_preferences: readonly string[];
    help_areas: readonly string[];
    learned_profile: string | null;
  };
  ownerName: string;
}): boolean {
  const unsetOrOwnerName = (value: string | null) => value === null || (ownerName !== '' && value === ownerName);
  return (
    profile.assistant_name === null &&
    profile.assistant_identity === null &&
    profile.voice_guidance === null &&
    unsetOrOwnerName(profile.user_name) &&
    unsetOrOwnerName(profile.address_as) &&
    profile.user_profile === null &&
    profile.learned_profile === null &&
    profile.pinned_preferences.length === 0 &&
    profile.help_areas.length === 0
  );
}

/**
 * Connectors the owner added or changed. The default web search connector, still exactly as the
 * instance was given it, is not one: a fresh instance has it, and the import leaves it in place.
 */
async function ownConnectors<TTransaction>(
  deps: PreflightDeps<TTransaction>,
  tenantId: string,
): Promise<{ own: McpServerRecord[]; defaultSearch: McpServerRecord | undefined }> {
  const own: McpServerRecord[] = [];
  let defaultSearch: McpServerRecord | undefined;
  for (const record of await deps.mcpServerStore.listServers({ tenant_id: tenantId, names: undefined })) {
    const untouched = await isUntouchedDefaultSearchConnector({
      record,
      catalog: deps.mcpCatalog,
      clientStore: deps.mcpServerStore,
    });
    if (untouched) {
      defaultSearch = record;
    } else {
      own.push(record);
    }
  }
  return { own, defaultSearch };
}

/** The untouched default web search connector the import keeps, when the instance has it. */
export async function findDefaultSearchConnector<TTransaction>(
  deps: PreflightDeps<TTransaction>,
  tenantId: string,
): Promise<McpServerRecord | undefined> {
  return (await ownConnectors(deps, tenantId)).defaultSearch;
}

/** True when the target tenant's Markdown vault holds memory content in any file outside `ignored`. */
async function markdownMemoryHasContent(input: {
  markdownDir: string;
  tenantId: string;
  ignored: ReadonlySet<string>;
}): Promise<boolean> {
  const { markdownDir, tenantId, ignored } = input;
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
    const memoryMd = path.join(dirPath, CURATED_MEMORY_FILE);
    if (!ignored.has(memoryMd) && existsSync(memoryMd) && (await readFile(memoryMd, 'utf8')).trim().length > 0) {
      return true;
    }
    const tombstones = path.join(dirPath, VAULT_TOMBSTONES_FILE);
    if (!ignored.has(tombstones) && existsSync(tombstones)) {
      return true;
    }
    const dailyDir = path.join(dirPath, 'memory');
    if (existsSync(dailyDir)) {
      const dailyFiles = (await readdir(dailyDir, { withFileTypes: true })).filter(
        entry =>
          entry.isFile() && DAILY_LOG_FILE_PATTERN.test(entry.name) && !ignored.has(path.join(dailyDir, entry.name)),
      );
      if (dailyFiles.length > 0) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Every kind of data the instance already holds, leaving out the items in
 * `ignoring`. A personalization profile the app created on first sign-in
 * (nothing filled in but the installer's name) does not count; the import replaces it. The default web
 * search connector, untouched, does not count; the import keeps it. Global and
 * permission settings do not count either: the import only fills settings the
 * instance has not set.
 */
export async function findInstanceData<TTransaction>(
  deps: PreflightDeps<TTransaction>,
  input: {
    tenantId: string;
    subjectId: string;
    scope: { created_by_subject_id: string; agent_ids: readonly string[] };
    ignoring: ImportLedger;
  },
): Promise<string[]> {
  const { tenantId, subjectId, scope, ignoring } = input;
  const found: string[] = [];
  const ignoredSessions = new Set(ignoring.session_ids);
  const ignoredFolders = new Set(ignoring.folder_ids);
  const ignoredAgents = new Set(ignoring.agent_ids);

  let sessionToken: string | undefined;
  do {
    const sessionPage = await deps.sessionStore.listSessions({
      tenant_id: tenantId,
      limit: PAGE_SIZE,
      page_token: sessionToken,
      order: 'asc',
      start_timestamp: undefined,
      end_timestamp: undefined,
      agent_id: undefined,
      created_by_or_agent_ids: scope,
      metadata: undefined,
      source_type: undefined,
      source_id: undefined,
    });
    if (sessionPage.data.some(session => !ignoredSessions.has(session.session_id))) {
      found.push('chats');
      break;
    }
    sessionToken = sessionPage.pagination.next_page_token;
  } while (sessionToken !== undefined);
  const folders = await deps.sessionStore.listSessionFolders({ tenant_id: tenantId, created_by: subjectId });
  if (folders.some(folder => !ignoredFolders.has(folder.folder_id))) {
    found.push('folders');
  }
  if ((await deps.personaStore.listPersonas({ tenant_id: tenantId, created_by: subjectId })).length > 0) {
    found.push('personas');
  }
  const profile = await deps.personalizationStore.getProfile({ tenant_id: tenantId, created_by: subjectId });
  if (profile !== undefined && !isPristineProfile({ profile, ownerName: deps.ownerName })) {
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
  let agentToken: string | undefined;
  do {
    const agentPage = await deps.agentStore.listAgents({
      tenant_id: tenantId,
      agent_name: undefined,
      include_host_managed: true,
      limit: PAGE_SIZE,
      page_token: agentToken,
    });
    if (agentPage.data.some(agent => !ignoredAgents.has(agent.id))) {
      found.push('agents');
      break;
    }
    agentToken = agentPage.pagination.next_page_token;
  } while (agentToken !== undefined);
  if ((await ownConnectors(deps, tenantId)).own.length > 0) {
    found.push('connectors');
  }
  if (deps.memoryTarget.kind === 'markdown') {
    const markdownDir = deps.memoryTarget.markdownDir;
    if (await markdownMemoryHasContent({ markdownDir, tenantId, ignored: new Set(ignoring.memory_files) })) {
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

  return found;
}

/** Refuses unless the instance is fresh, naming every kind of data it already holds. */
export async function assertInstanceEmpty<TTransaction>(
  deps: PreflightDeps<TTransaction>,
  input: {
    tenantId: string;
    subjectId: string;
    scope: { created_by_subject_id: string; agent_ids: readonly string[] };
  },
): Promise<void> {
  const found = await findInstanceData(deps, { ...input, ignoring: emptyLedger() });
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
