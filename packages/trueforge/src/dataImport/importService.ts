/**
 * Data import: restores an export archive into an empty instance.
 *
 * The archive is read strictly (size caps, path rules, every JSON section
 * validated against a Zod schema) and cross-checked before anything is
 * written; the session restore is then replayed against an in-memory store to
 * prove it lands cleanly. Writes run in a fixed order with the database
 * transaction last, so a failure at any earlier step can be fully undone and
 * the instance is left empty for a retry: placeholder agents, folders and
 * sessions, persona knowledge files, and memory files are compensated by
 * deletion, and the remaining records (personas, personalization, spaces,
 * schedules, connectors, settings, artifacts) commit in one transaction or
 * not at all.
 *
 * Every imported record belongs to the importing user. Ids are kept, so
 * links inside chats keep working. Schedules arrive switched off. Connectors
 * arrive without credentials, so ones that need sign-in show that state.
 */
import {
  AgentSpecSchema,
  InMemorySessionStore,
  type CreatedBySubject,
  type ISessionStore,
} from '@truefoundry/trueforge-core/agent-session';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { sanitizeZipPath } from '../dataExport/exportService';
import type { IAgentStore } from '../db/agentStore';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IMcpServerStore } from '../db/mcpServerStore';
import type { IPersonaStore } from '../db/personaStore';
import type { IPersonalizationStore } from '../db/personalizationStore';
import type { IScheduleStore } from '../db/scheduleStore';
import type { ISentinelSettingsStore } from '../db/sentinelSettingsStore';
import { parseTurnCustom, type SessionCustom, type TurnCustom } from '../db/sessionCustom';
import type { ISpaceStore } from '../db/spaceStore';
import type { WithTransaction } from '../db/transaction';
import type { ITurnArtifactStore } from '../db/turnArtifactStore';
import { ensurePersonaKnowledgeRoot, personaKnowledgeLocation } from '../personaKnowledge/knowledgePaths';
import { openPersonaKnowledgeRepository } from '../personaKnowledge/sqliteKnowledgeRepository';
import { EMBEDDING_DIMENSIONS } from '../runtime/memory/embeddingModel';
import type { RetainItem } from '../runtime/memory/hindsightClient';
import { splitEntries, vaultEntryTimestamp, vaultFilesystemNamespace } from '../runtime/memory/markdownMemoryFiles';
import type { MemoryClient } from '../runtime/memory/memoryClient';
import { newId } from '../utils/id';
import {
  DATA_IMPORT_SCHEMA_VERSION,
  ImportChatsFileSchema,
  ImportConnectorsFileSchema,
  ImportFoldersFileSchema,
  ImportManifestSchema,
  ImportPersonalizationFileSchema,
  ImportPersonasFileSchema,
  ImportSchedulesFileSchema,
  ImportSessionsFileSchema,
  ImportSettingsFileSchema,
  ImportSpacesFileSchema,
  type ImportConnectorRecord,
  type ImportFolderRecord,
  type ImportKnowledgeDocument,
  type ImportManifest,
  type ImportPersonalizationFile,
  type ImportPersonasFile,
  type ImportScheduleRecord,
  type ImportSessionEntry,
  type ImportSettingsFile,
  type ImportSpacesFile,
} from './importSchemas';
import { restoreSessions, type SessionRestoreContext } from './sessionRestore';
import { readZipArchive, ZipArchiveError, type ZipArchiveEntry } from './zipArchiveReader';

export class DataImportError extends Error {
  readonly status: 400 | 409 | 500;

  constructor(message: string, status: 400 | 409 | 500, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DataImportError';
    this.status = status;
  }
}

export type MemoryImportTarget = { kind: 'markdown'; markdownDir: string } | { kind: 'client'; client: MemoryClient };

export interface DataImportDeps<TTransaction> {
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  personaStore: IPersonaStore<TTransaction>;
  personalizationStore: IPersonalizationStore<TTransaction>;
  spaceStore: ISpaceStore<TTransaction>;
  scheduleStore: IScheduleStore<TTransaction>;
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  sentinelSettingsStore: ISentinelSettingsStore<TTransaction>;
  turnArtifactStore: ITurnArtifactStore<TTransaction>;
  mcpServerStore: IMcpServerStore<TTransaction>;
  agentStore: IAgentStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  memoryTarget: MemoryImportTarget;
  personaKnowledgeDir: string;
  /**
   * Embeds knowledge chunk texts for re-indexing. Returns null when the
   * embedding model is unavailable; chunks are then stored with empty vectors
   * so no text is lost, and search quality returns when the model loads.
   */
  embedKnowledgeChunks: (texts: string[]) => Promise<readonly Float32Array[] | null>;
}

export interface DataImportRequest {
  archive: Buffer;
  subject: {
    tenantId: string;
    subjectId: string;
    subjectDisplayName: string;
    agentIds: readonly string[];
  };
  /** Cap for the archive itself and for its total uncompressed size. */
  maxBytes: number;
}

export interface DataImportResult {
  chats: number;
  memories: number;
  personas: number;
  spaces: number;
  schedules: number;
  folders: number;
  connectors: number;
  connectors_skipped: number;
  /** True when schedules were imported; they all arrive switched off. */
  schedules_off: boolean;
  /** Plain-words summary of what arrived and what did not. */
  summary: string;
}

/** Per-file uncompressed cap inside the archive. */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MEMORY_RETAIN_TIMEOUT_MS = 120_000;

const REQUIRED_SECTIONS = [
  'manifest.json',
  'chats.json',
  'sessions.json',
  'folders.json',
  'personas.json',
  'personalization.json',
  'spaces.json',
  'schedules.json',
  'connectors.json',
  'settings.json',
] as const;

function parseSection<T>(
  files: ReadonlyMap<string, Buffer>,
  name: string,
  schema: { parse: (value: unknown) => T },
): T {
  const data = files.get(name);
  if (data === undefined) {
    throw new DataImportError(`This export is missing its ${name} section, so nothing was imported.`, 400);
  }
  let json: unknown;
  try {
    json = JSON.parse(data.toString('utf8'));
  } catch (cause) {
    throw new DataImportError(`The ${name} section of this export is damaged, so nothing was imported.`, 400, {
      cause,
    });
  }
  try {
    return schema.parse(json);
  } catch (cause) {
    throw new DataImportError(`The ${name} section of this export is damaged, so nothing was imported.`, 400, {
      cause,
    });
  }
}

interface ArchiveContents {
  manifest: ImportManifest;
  sessions: ImportSessionEntry[];
  folders: ImportFolderRecord[];
  personas: ImportPersonasFile;
  personalization: ImportPersonalizationFile;
  spaces: ImportSpacesFile;
  schedules: ImportScheduleRecord[];
  connectors: ImportConnectorRecord[];
  settings: ImportSettingsFile;
  files: ReadonlyMap<string, Buffer>;
  sourceTenantId: string;
}

function loadArchive(archive: Buffer, maxBytes: number): ArchiveContents {
  let entries: ZipArchiveEntry[];
  try {
    entries = readZipArchive(archive, {
      maxEntryBytes: Math.min(MAX_ENTRY_BYTES, maxBytes),
      maxTotalBytes: maxBytes,
      maxEntries: MAX_ENTRIES,
    });
  } catch (cause) {
    if (cause instanceof ZipArchiveError) {
      throw new DataImportError(cause.message, 400, { cause });
    }
    throw cause;
  }
  const files = new Map(entries.map(entry => [entry.name, entry.data]));
  for (const name of REQUIRED_SECTIONS) {
    if (!files.has(name)) {
      throw new DataImportError(`This export is missing its ${name} section, so nothing was imported.`, 400);
    }
  }

  const manifest = parseSection(files, 'manifest.json', ImportManifestSchema);
  if (manifest.format !== 'aman-export') {
    throw new DataImportError('This file is not an Aman data export, so nothing was imported.', 400);
  }
  if (manifest.schema_version > DATA_IMPORT_SCHEMA_VERSION) {
    throw new DataImportError(
      `This export was made by a newer version of Aman (format version ${String(manifest.schema_version)}). Update Aman, then import again.`,
      400,
    );
  }
  if (manifest.schema_version < 1) {
    throw new DataImportError('This export uses a format version this Aman cannot read, so nothing was imported.', 400);
  }

  // chats.json is validated even though sessions.json is the restore source:
  // a damaged section means the archive cannot be trusted as a whole.
  parseSection(files, 'chats.json', ImportChatsFileSchema);
  const sessions = parseSection(files, 'sessions.json', ImportSessionsFileSchema);
  const folders = parseSection(files, 'folders.json', ImportFoldersFileSchema);
  const personas = parseSection(files, 'personas.json', ImportPersonasFileSchema);
  const personalization = parseSection(files, 'personalization.json', ImportPersonalizationFileSchema);
  const spaces = parseSection(files, 'spaces.json', ImportSpacesFileSchema);
  const schedules = parseSection(files, 'schedules.json', ImportSchedulesFileSchema);
  const connectors = parseSection(files, 'connectors.json', ImportConnectorsFileSchema);
  const settings = parseSection(files, 'settings.json', ImportSettingsFileSchema);

  const sourceTenantId =
    sessions[0]?.session.tenant_id ??
    personas[0]?.persona.tenant_id ??
    schedules[0]?.tenant_id ??
    folders[0]?.tenant_id ??
    'default';

  const contents: ArchiveContents = {
    manifest,
    sessions,
    folders,
    personas,
    personalization,
    spaces,
    schedules,
    connectors,
    settings,
    files,
    sourceTenantId,
  };
  validateCrossReferences(contents);
  return contents;
}

function damaged(detail: string): DataImportError {
  return new DataImportError(`This export is damaged: ${detail} Nothing was imported.`, 400);
}

function validateCrossReferences(contents: ArchiveContents): void {
  const { sessions, folders, personas, spaces, schedules, connectors } = contents;

  const folderIds = new Set<string>();
  for (const folder of folders) {
    if (folderIds.has(folder.folder_id)) {
      throw damaged(`folder ${folder.folder_id} appears twice.`);
    }
    folderIds.add(folder.folder_id);
  }

  const sessionIds = new Set<string>();
  for (const entry of sessions) {
    const session = entry.session;
    if (sessionIds.has(session.session_id)) {
      throw damaged(`chat ${session.session_id} appears twice.`);
    }
    sessionIds.add(session.session_id);
    if (session.folder_id !== null && !folderIds.has(session.folder_id)) {
      throw damaged(`chat ${session.session_id} points at a folder that is not in the export.`);
    }
    const custom = session.custom;
    if (custom !== null && custom !== undefined && !(typeof custom === 'object' && Object.keys(custom).length === 0)) {
      throw damaged(`chat ${session.session_id} carries data this version cannot restore.`);
    }
    const turnIds = new Set<string>();
    for (const { turn } of entry.turns) {
      if (turn.session_id !== session.session_id) {
        throw damaged(`a turn in chat ${session.session_id} belongs to a different chat.`);
      }
      if (turnIds.has(turn.turn_id)) {
        throw damaged(`turn ${turn.turn_id} appears twice in chat ${session.session_id}.`);
      }
      turnIds.add(turn.turn_id);
      try {
        parseTurnCustom(turn.custom ?? null);
      } catch (cause) {
        throw new DataImportError(
          `This export is damaged: a turn in chat ${session.session_id} carries data this version cannot restore. Nothing was imported.`,
          400,
          { cause },
        );
      }
    }
    for (const artifact of entry.artifacts) {
      if (artifact.session_id !== session.session_id || !turnIds.has(artifact.turn_id)) {
        throw damaged(`a stored file in chat ${session.session_id} points at a turn that is not in the export.`);
      }
    }
  }

  const personaIds = new Set<string>();
  for (const { persona } of personas) {
    if (personaIds.has(persona.id)) {
      throw damaged(`persona ${persona.id} appears twice.`);
    }
    personaIds.add(persona.id);
  }

  for (const { space, revisions } of spaces) {
    const numbers = revisions.map(revision => revision.revision).sort((a, b) => a - b);
    const complete = numbers.length === space.revision && numbers.every((value, index) => value === index + 1);
    if (!complete) {
      throw damaged(`space ${space.id} is missing some of its revisions.`);
    }
    if (revisions.some(revision => revision.id !== space.id)) {
      throw damaged(`space ${space.id} has a revision that belongs to a different space.`);
    }
  }

  const scheduleIds = new Set<string>();
  const scheduleNames = new Set<string>();
  for (const schedule of schedules) {
    if (scheduleIds.has(schedule.id)) {
      throw damaged(`schedule ${schedule.id} appears twice.`);
    }
    scheduleIds.add(schedule.id);
    const nameKey = `${schedule.agent_name ?? ''}\n${schedule.name}`;
    if (scheduleNames.has(nameKey)) {
      throw damaged(`two schedules named ${schedule.name} appear in the export.`);
    }
    scheduleNames.add(nameKey);
  }

  const connectorNames = new Set<string>();
  for (const connector of connectors) {
    if (connectorNames.has(connector.name)) {
      throw damaged(`connector ${connector.name} appears twice.`);
    }
    connectorNames.add(connector.name);
  }
}

interface Tombstone {
  action: string;
  text: string | undefined;
}

/** Parses `.vault-tombstones.md` marker blocks: later markers win per entry id. */
function parseVaultTombstones(content: string): Map<string, Tombstone> {
  const tombstones = new Map<string, Tombstone>();
  for (const line of content.split('\n')) {
    if (!line.startsWith('> vault-entry ')) {
      continue;
    }
    const rest = line.slice('> vault-entry '.length).trim();
    const [entryId, action, ...payloadParts] = rest.split(/\s+/);
    if (entryId === undefined || action === undefined) {
      continue;
    }
    let text: string | undefined;
    if (payloadParts.length > 0) {
      try {
        const payload: unknown = JSON.parse(payloadParts.join(' '));
        if (typeof payload === 'object' && payload !== null && 'text' in payload) {
          const value = payload.text;
          text = typeof value === 'string' ? value : undefined;
        }
      } catch {
        text = undefined;
      }
    }
    tombstones.set(entryId, { action, text });
  }
  return tombstones;
}

interface ParsedMemoryNamespace {
  seg: string;
  curated: string | undefined;
  entries: { id: string; file: string; text: string }[];
}

/** Groups the archive's memory/ files by namespace segment and applies tombstones, mirroring the vault scanner. */
function parseMemoryNamespaces(files: ReadonlyMap<string, Buffer>): ParsedMemoryNamespace[] {
  const bySeg = new Map<string, { curated?: string; tombstones?: string; daily: Map<string, string> }>();
  for (const [name, data] of files) {
    if (!name.startsWith('memory/')) {
      continue;
    }
    const rest = name.slice('memory/'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      continue;
    }
    const seg = rest.slice(0, slash);
    const inner = rest.slice(slash + 1);
    let bucket = bySeg.get(seg);
    if (bucket === undefined) {
      bucket = { daily: new Map() };
      bySeg.set(seg, bucket);
    }
    if (inner === 'MEMORY.md') {
      bucket.curated = data.toString('utf8');
    } else if (inner === '.vault-tombstones.md') {
      bucket.tombstones = data.toString('utf8');
    } else if (/^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(inner)) {
      bucket.daily.set(inner.slice('memory/'.length), data.toString('utf8'));
    }
  }

  const namespaces: ParsedMemoryNamespace[] = [];
  for (const [seg, bucket] of bySeg) {
    const tombstones =
      bucket.tombstones === undefined ? new Map<string, Tombstone>() : parseVaultTombstones(bucket.tombstones);
    const entries: ParsedMemoryNamespace['entries'] = [];
    for (const file of [...bucket.daily.keys()].sort()) {
      const content = bucket.daily.get(file);
      if (content === undefined) {
        continue;
      }
      const parts = splitEntries(content);
      for (let index = 0; index < parts.length; index += 1) {
        const text = parts[index];
        if (text === undefined) {
          continue;
        }
        const id = `md:${seg}:${file}#${String(index)}`;
        const tombstone = tombstones.get(id);
        if (tombstone === undefined) {
          entries.push({ id, file, text });
        } else if (tombstone.action === 'updated' && tombstone.text !== undefined) {
          entries.push({ id, file, text: tombstone.text });
        }
      }
    }
    const curated = bucket.curated?.trim();
    namespaces.push({ seg, curated: curated === undefined || curated.length === 0 ? undefined : curated, entries });
  }
  return namespaces;
}

/** Maps an archive memory namespace segment to the target tenant's segment for the same vault. */
function targetMemorySegment(input: {
  sourceSeg: string;
  sourceTenantId: string;
  targetTenantId: string;
  personaSegBySource: ReadonlyMap<string, string>;
}): string | undefined {
  const { sourceSeg, sourceTenantId, targetTenantId, personaSegBySource } = input;
  if (sourceSeg === sourceTenantId) {
    return targetTenantId;
  }
  const personaTarget = personaSegBySource.get(sourceSeg);
  if (personaTarget !== undefined) {
    return personaTarget;
  }
  const prefix = `${sourceTenantId}__`;
  if (sourceSeg.startsWith(prefix)) {
    return `${targetTenantId}__${sourceSeg.slice(prefix.length)}`;
  }
  return undefined;
}

function countMemories(namespaces: readonly ParsedMemoryNamespace[]): number {
  return namespaces.reduce(
    (sum, namespace) => sum + namespace.entries.length + (namespace.curated === undefined ? 0 : 1),
    0,
  );
}

/** Builds retain items for a client (non-Markdown) memory backend from the parsed namespaces. */
function buildRetainItems(
  namespaces: readonly ParsedMemoryNamespace[],
  input: { exportedAt: string; personaWireBySourceSeg: ReadonlyMap<string, string> },
): RetainItem[] {
  const items: RetainItem[] = [];
  const documentIdFor = (seed: string): string =>
    `import-${createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32)}`;
  for (const namespace of namespaces) {
    // A client backend has one bank per tenant, so a persona vault's entries
    // keep their origin as the retain context instead of a separate vault.
    const vaultContext = input.personaWireBySourceSeg.get(namespace.seg);
    if (namespace.curated !== undefined) {
      items.push({
        content: namespace.curated,
        timestamp: input.exportedAt,
        document_id: documentIdFor(`curated:${namespace.seg}`),
        ...(vaultContext === undefined ? {} : { context: vaultContext }),
      });
    }
    for (const entry of namespace.entries) {
      let body = entry.text;
      let entryContext: string | undefined;
      if (body.startsWith('## ')) {
        const newline = body.indexOf('\n');
        body = newline < 0 ? '' : body.slice(newline + 1).replace(/^\n+/, '');
      }
      const contextMatch = /\n\n> ([^\n]*)$/.exec(body);
      if (contextMatch !== null) {
        const contextValue = contextMatch[1];
        if (contextValue !== undefined) {
          entryContext = contextValue;
          body = body.slice(0, contextMatch.index);
        }
      }
      const itemContext = vaultContext ?? entryContext;
      items.push({
        content: body,
        timestamp: vaultEntryTimestamp({ file: entry.file, text: entry.text }),
        document_id: documentIdFor(entry.id),
        ...(itemContext === undefined ? {} : { context: itemContext }),
      });
    }
  }
  return items;
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}

function buildSummary(result: Omit<DataImportResult, 'summary' | 'schedules_off'>): string {
  const counts = [
    pluralize(result.chats, 'chat', 'chats'),
    pluralize(result.memories, 'memory', 'memories'),
    pluralize(result.personas, 'persona', 'personas'),
    pluralize(result.spaces, 'space', 'spaces'),
    result.schedules === 0
      ? pluralize(0, 'schedule', 'schedules')
      : `${pluralize(result.schedules, 'schedule', 'schedules')} (off)`,
  ];
  return (
    `Imported ${counts.join(', ')}. ` +
    'Not imported: model keys, connector sign-ins, Always allow choices. Set those up in Settings.'
  );
}

interface ImportProgress {
  agentIdsCreated: string[];
  folderIds: string[];
  sessionIds: string[];
  knowledgePersonaIds: string[];
  memoryFilesWritten: string[];
}

export async function runDataImport<TTransaction>(
  deps: DataImportDeps<TTransaction>,
  request: DataImportRequest,
): Promise<DataImportResult> {
  const { tenantId, subjectId } = request.subject;
  if (request.archive.byteLength > request.maxBytes) {
    throw new DataImportError('The file is larger than the import limit, so nothing was imported.', 400);
  }
  const contents = loadArchive(request.archive, request.maxBytes);
  const { manifest, sessions, folders, personas, personalization, spaces, schedules, connectors, settings } = contents;
  const importerSubject: CreatedBySubject = {
    subject_id: subjectId,
    subject_type: 'user',
    subject_display_name: request.subject.subjectDisplayName,
  };
  const scope = { created_by_subject_id: subjectId, agent_ids: request.subject.agentIds };

  // --- Agent resolution plan (reads only) ---
  const referencedAgentNames = new Set<string>();
  for (const schedule of schedules) {
    if (schedule.agent_name !== null) {
      referencedAgentNames.add(schedule.agent_name);
    }
  }
  for (const entry of sessions) {
    if (entry.session.agent.type === 'reference' && entry.session.agent.name !== null) {
      referencedAgentNames.add(entry.session.agent.name);
    }
  }
  const agentIdByName = new Map<string, string>();
  for (const name of referencedAgentNames) {
    const existing = await deps.agentStore.getAgent({ tenant_id: tenantId, name });
    if (existing !== undefined) {
      agentIdByName.set(name, existing.id);
    }
  }
  // Schedules whose record carries no agent name resolve by their exported
  // agent id instead; that only works when the target already has that agent.
  const scheduleAgentByScheduleId = new Map<string, { agentId: string; agentName: string }>();
  for (const schedule of schedules) {
    if (schedule.agent_name !== null) {
      continue;
    }
    const byId = await deps.agentStore.getAgent({ tenant_id: tenantId, id: schedule.agent_id });
    if (byId === undefined) {
      throw new DataImportError(
        'This export has a schedule whose agent is missing, so nothing was imported. Recreate the export and try again.',
        400,
      );
    }
    scheduleAgentByScheduleId.set(schedule.id, { agentId: byId.id, agentName: byId.name });
  }

  // --- Emptiness check ---
  await assertInstanceEmpty(deps, { tenantId, subjectId, scope });

  // --- Memory plan (parsed before any writes) ---
  const personaSegBySource = new Map<string, string>();
  for (const { persona } of personas) {
    const wire = `persona:${persona.display_name}`;
    personaSegBySource.set(
      vaultFilesystemNamespace(contents.sourceTenantId, wire),
      vaultFilesystemNamespace(tenantId, wire),
    );
  }
  const personaWireBySourceSeg = new Map<string, string>();
  for (const { persona } of personas) {
    personaWireBySourceSeg.set(
      vaultFilesystemNamespace(contents.sourceTenantId, `persona:${persona.display_name}`),
      `persona:${persona.display_name}`,
    );
  }
  const memoryNamespaces = parseMemoryNamespaces(contents.files);
  for (const namespace of memoryNamespaces) {
    const target = targetMemorySegment({
      sourceSeg: namespace.seg,
      sourceTenantId: contents.sourceTenantId,
      targetTenantId: tenantId,
      personaSegBySource,
    });
    if (target === undefined) {
      throw new DataImportError(
        'The memory section of this export belongs to a different account, so nothing was imported.',
        400,
      );
    }
  }
  const memoryCount = countMemories(memoryNamespaces);

  // --- Replay the session restore in memory: proves the decomposition lands before real writes begin. ---
  const restoreContext: SessionRestoreContext = { tenantId, subject: importerSubject, agentIdByName };
  try {
    const replayStore = new InMemorySessionStore<SessionCustom, TurnCustom>();
    for (const folder of folders) {
      await replayStore.createSessionFolder({
        tenant_id: tenantId,
        folder_id: folder.folder_id,
        created_by: subjectId,
        name: folder.name,
      });
    }
    await restoreSessions(replayStore, restoreContext, sessions);
  } catch (cause) {
    if (cause instanceof DataImportError) {
      throw cause;
    }
    throw new DataImportError(
      'The chats in this export could not be read back, so nothing was imported. The export may be damaged.',
      400,
      { cause },
    );
  }

  const progress: ImportProgress = {
    agentIdsCreated: [],
    folderIds: [],
    sessionIds: sessions.map(entry => entry.session.session_id),
    knowledgePersonaIds: [],
    memoryFilesWritten: [],
  };

  try {
    // --- Placeholder agents for referenced names the target does not have. ---
    for (const name of referencedAgentNames) {
      if (agentIdByName.has(name)) {
        continue;
      }
      const created = await deps.agentStore.createAgent({
        tenant_id: tenantId,
        name,
        description:
          'Created by data import so imported schedules and chats keep their agent name. Set the model and instructions before use.',
        manifest: AgentSpecSchema.parse({
          model: { name: 'imported/unconfigured' },
          instructions: 'This agent was created by a data import. Set its instructions before use.',
        }),
        external_id: null,
        created_by_subject: importerSubject,
      });
      agentIdByName.set(name, created.id);
      progress.agentIdsCreated.push(created.id);
    }

    // --- Folders and sessions. ---
    for (const folder of folders) {
      await deps.sessionStore.createSessionFolder({
        tenant_id: tenantId,
        folder_id: folder.folder_id,
        created_by: subjectId,
        name: folder.name,
      });
      progress.folderIds.push(folder.folder_id);
    }
    await restoreSessions(deps.sessionStore, restoreContext, sessions);

    // --- Persona knowledge libraries, re-indexed with fresh embeddings. ---
    for (const { persona, knowledge } of personas) {
      if (knowledge.documents.length === 0) {
        continue;
      }
      await importPersonaKnowledge(deps, { tenantId, personaId: persona.id, documents: knowledge.documents });
      progress.knowledgePersonaIds.push(persona.id);
    }

    // --- Memory: verbatim files for the Markdown backend, retains for a client backend. ---
    if (deps.memoryTarget.kind === 'markdown') {
      progress.memoryFilesWritten = await writeMarkdownMemory(deps.memoryTarget.markdownDir, contents, {
        targetTenantId: tenantId,
        personaSegBySource,
      });
    } else if (memoryNamespaces.length > 0) {
      const items = buildRetainItems(memoryNamespaces, {
        exportedAt: manifest.exported_at,
        personaWireBySourceSeg,
      });
      if (items.length > 0) {
        const outcome = await deps.memoryTarget.client.retain({
          items,
          operationId: `data-import-${newId()}`,
          timeoutMs: MEMORY_RETAIN_TIMEOUT_MS,
        });
        if (!outcome.ok) {
          throw new DataImportError(
            `The memory store could not save the imported memories${outcome.reason === undefined ? '' : `: ${outcome.reason}`}. Nothing was imported.`,
            500,
          );
        }
      }
    }

    // --- Everything else commits in one transaction. ---
    let connectorsImported = 0;
    let connectorsSkipped = 0;
    const existingServers = await deps.mcpServerStore.listServers({ tenant_id: tenantId, names: undefined });
    const existingNames = new Set(existingServers.map(server => server.name));
    await deps.withTransaction(async tx => {
      for (const { persona } of personas) {
        await deps.personaStore.createPersona(
          {
            tenant_id: tenantId,
            created_by: subjectId,
            id: persona.id,
            display_name: persona.display_name,
            aliases: persona.aliases,
            instructions: persona.instructions,
            model_name: persona.model_name,
            updated_by: subjectId,
          },
          tx,
        );
      }

      if (personalization !== null) {
        await deps.personalizationStore.upsertProfile(
          {
            tenant_id: tenantId,
            created_by: subjectId,
            assistant_name: personalization.assistant_name,
            assistant_identity: personalization.assistant_identity,
            voice_guidance: personalization.voice_guidance,
            user_profile: personalization.user_profile,
            pinned_preferences: personalization.pinned_preferences,
            learned_profile: personalization.learned_profile,
            learning_enabled: personalization.learning_enabled,
            updated_by: subjectId,
            expected_revision: null,
          },
          tx,
        );
      }

      for (const { space, revisions } of spaces) {
        const sorted = [...revisions].sort((a, b) => a.revision - b.revision);
        const first = sorted[0];
        if (first === undefined) {
          continue;
        }
        const contentOf = (record: typeof first) => ({
          name: record.name,
          purpose: record.purpose,
          status: record.status,
          body: record.body,
          format: record.format,
        });
        let aggregate = await deps.spaceStore.getAggregate({ tenant_id: tenantId, created_by: subjectId }, tx);
        await deps.spaceStore.createSpace(
          {
            tenant_id: tenantId,
            created_by: subjectId,
            id: space.id,
            ...contentOf(first),
            expected_aggregate_revision: aggregate.revision,
          },
          tx,
        );
        for (const revision of sorted.slice(1)) {
          aggregate = await deps.spaceStore.getAggregate({ tenant_id: tenantId, created_by: subjectId }, tx);
          await deps.spaceStore.updateSpace(
            {
              tenant_id: tenantId,
              created_by: subjectId,
              space_id: space.id,
              ...contentOf(revision),
              expected_revision: revision.revision - 1,
              expected_aggregate_revision: aggregate.revision,
            },
            tx,
          );
        }
      }

      for (const schedule of schedules) {
        const resolved =
          schedule.agent_name !== null
            ? { agentId: agentIdByName.get(schedule.agent_name), agentName: schedule.agent_name }
            : scheduleAgentByScheduleId.get(schedule.id);
        const resolvedAgentId = resolved?.agentId;
        if (resolved === undefined || resolvedAgentId === undefined) {
          throw new DataImportError('A schedule in this export names an agent that could not be restored.', 400);
        }
        await deps.scheduleStore.createScheduleAndRun(
          {
            id: schedule.id,
            tenant_id: tenantId,
            agent_id: resolvedAgentId,
            agent_name: resolved.agentName,
            name: schedule.name,
            manifest: { ...schedule.manifest, status: 'paused' },
            created_by_subject: importerSubject,
            runFrom: new Date(),
          },
          tx,
        );
      }

      for (const connector of connectors) {
        if (existingNames.has(connector.name)) {
          connectorsSkipped += 1;
          continue;
        }
        await deps.mcpServerStore.createServer(
          {
            tenant_id: tenantId,
            name: connector.name,
            manifest: connector.manifest,
            first_party: connector.first_party,
          },
          tx,
        );
        connectorsImported += 1;
      }

      for (const setting of settings.global) {
        await deps.globalSettingsStore.setSetting({ key: setting.key, value: setting.value }, tx);
      }
      await deps.sentinelSettingsStore.patch(
        {
          tenant_id: tenantId,
          created_by: subjectId,
          offline_mode: settings.permission_settings.offline_mode,
          tier2_auto_allow: settings.permission_settings.tier2_auto_allow,
          search_without_asking: settings.permission_settings.search_without_asking,
        },
        tx,
      );

      for (const entry of sessions) {
        for (const artifact of entry.artifacts) {
          const identity = {
            tenant_id: tenantId,
            session_id: artifact.session_id,
            turn_id: artifact.turn_id,
            path: artifact.path,
          };
          if (artifact.status === 'stored') {
            const blobName = `files/${sanitizeZipPath(artifact.session_id)}/${sanitizeZipPath(artifact.path)}`;
            const blob = contents.files.get(blobName);
            if (blob !== undefined) {
              await deps.turnArtifactStore.recordStoredArtifact(
                { ...identity, name: artifact.name, data: blob, mime: artifact.mime ?? 'application/octet-stream' },
                tx,
              );
            } else {
              await deps.turnArtifactStore.recordSkippedArtifact(
                {
                  ...identity,
                  name: artifact.name,
                  status: 'skipped_missing',
                  skip_reason: 'The file itself was not included in the export.',
                  size: artifact.size ?? undefined,
                },
                tx,
              );
            }
          } else {
            await deps.turnArtifactStore.recordSkippedArtifact(
              {
                ...identity,
                name: artifact.name,
                status: artifact.status,
                skip_reason: artifact.skip_reason ?? 'The file was not stored by the source instance.',
                size: artifact.size ?? undefined,
              },
              tx,
            );
          }
        }
      }
    });

    const result: Omit<DataImportResult, 'summary'> = {
      chats: sessions.length,
      memories: memoryCount,
      personas: personas.length,
      spaces: spaces.length,
      schedules: schedules.length,
      folders: folders.length,
      connectors: connectorsImported,
      connectors_skipped: connectorsSkipped,
      schedules_off: schedules.length > 0,
    };
    return { ...result, summary: buildSummary(result) };
  } catch (cause) {
    await compensateImport(deps, { tenantId, subjectId, progress });
    if (cause instanceof DataImportError) {
      throw cause;
    }
    throw new DataImportError(
      'The import failed partway through, so everything it had written was removed again. The instance is empty and the import can be tried again.',
      500,
      { cause },
    );
  }
}

async function assertInstanceEmpty<TTransaction>(
  deps: DataImportDeps<TTransaction>,
  input: {
    tenantId: string;
    subjectId: string;
    scope: { created_by_subject_id: string; agent_ids: readonly string[] };
  },
): Promise<void> {
  const { tenantId, subjectId, scope } = input;
  const refuse = (): never => {
    throw new DataImportError(
      'This instance already has data, so the import was refused. Data imports only run into an empty instance, so nothing was changed.',
      409,
    );
  };

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
    refuse();
  }
  const personaList = await deps.personaStore.listPersonas({ tenant_id: tenantId, created_by: subjectId });
  if (personaList.length > 0) {
    refuse();
  }
  const profile = await deps.personalizationStore.getProfile({ tenant_id: tenantId, created_by: subjectId });
  if (profile !== undefined) {
    refuse();
  }
  const spaceList = await deps.spaceStore.listSpaces({
    tenant_id: tenantId,
    created_by: subjectId,
    status: undefined,
    limit: 1,
    offset: 0,
  });
  if (spaceList.length > 0) {
    refuse();
  }
  const schedulePage = await deps.scheduleStore.listSchedules({
    tenant_id: tenantId,
    limit: 1,
    page_token: undefined,
    agent_names: undefined,
    created_by_or_agent_ids: scope,
  });
  if (schedulePage.data.length > 0) {
    refuse();
  }

  if (deps.memoryTarget.kind === 'markdown') {
    if (await markdownMemoryHasContent(deps.memoryTarget.markdownDir, tenantId)) {
      refuse();
    }
  } else {
    const outcome = await deps.memoryTarget.client.listEntries({ namespace: '', timeoutMs: MEMORY_RETAIN_TIMEOUT_MS });
    if (!outcome.ok) {
      throw new DataImportError('The memory store could not be read, so the import cannot run.', 500);
    }
    if (outcome.entries.length > 0) {
      refuse();
    }
  }
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

async function importPersonaKnowledge<TTransaction>(
  deps: DataImportDeps<TTransaction>,
  input: {
    tenantId: string;
    personaId: string;
    documents: ImportKnowledgeDocument[];
  },
): Promise<void> {
  await ensurePersonaKnowledgeRoot({ knowledgeDir: deps.personaKnowledgeDir, tenantId: input.tenantId });
  const location = personaKnowledgeLocation({
    knowledgeDir: deps.personaKnowledgeDir,
    tenantId: input.tenantId,
    personaId: input.personaId,
  });
  const repository = openPersonaKnowledgeRepository({ dbPath: location.dbPath, dimensions: EMBEDDING_DIMENSIONS });
  try {
    // One embedding pass per library: every chunk text, in document order.
    const sortedDocuments = input.documents.map(document => ({
      document,
      chunks: [...document.chunks].sort((a, b) => a.chunk_index - b.chunk_index),
    }));
    const allTexts = sortedDocuments.flatMap(entry => entry.chunks.map(chunk => chunk.text));
    const embeddings = allTexts.length === 0 ? [] : await deps.embedKnowledgeChunks(allTexts);
    let cursor = 0;
    for (const { document, chunks } of sortedDocuments) {
      const created = repository.createDocument({
        title: document.title,
        titleExplicit: document.title_explicit,
        source_kind: document.source_kind,
        source_label: document.source_label,
        source_url: document.source_url,
      });
      if (chunks.length > 0) {
        repository.setDocumentChunks({
          documentId: created.id,
          chunks: chunks.map(chunk => {
            const embedding = embeddings?.[cursor] ?? new Float32Array(EMBEDDING_DIMENSIONS);
            cursor += 1;
            return { text: chunk.text, embedding };
          }),
        });
      }
      if (document.status === 'failed') {
        repository.updateDocumentStatus({
          documentId: created.id,
          status: 'failed',
          statusMessage: document.status_message,
        });
      } else {
        repository.updateDocumentStatus({ documentId: created.id, status: 'ready', statusMessage: null });
      }
    }
  } finally {
    repository.close();
  }
}

/** Writes the archive's memory/ files into the Markdown vault under the target tenant's segments. */
async function writeMarkdownMemory(
  markdownDir: string,
  contents: ArchiveContents,
  input: { targetTenantId: string; personaSegBySource: ReadonlyMap<string, string> },
): Promise<string[]> {
  const written: string[] = [];
  const knownFiles = new Set(['MEMORY.md', '.vault-tombstones.md', '.vault-sharing.json']);
  for (const [name, data] of contents.files) {
    if (!name.startsWith('memory/')) {
      continue;
    }
    const rest = name.slice('memory/'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      continue;
    }
    const sourceSeg = rest.slice(0, slash);
    const inner = rest.slice(slash + 1);
    const isDaily = /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(inner);
    if (!knownFiles.has(inner) && !isDaily) {
      continue;
    }
    const targetSeg = targetMemorySegment({
      sourceSeg,
      sourceTenantId: contents.sourceTenantId,
      targetTenantId: input.targetTenantId,
      personaSegBySource: input.personaSegBySource,
    });
    if (targetSeg === undefined) {
      throw new DataImportError('The memory section of this export belongs to a different account.', 400);
    }
    let bytes = data;
    if (inner === '.vault-tombstones.md' && targetSeg !== sourceSeg) {
      // Tombstone entry ids embed the vault namespace segment; retarget them
      // so edits and deletes still apply under the new tenant.
      const text = data.toString('utf8').split(`md:${sourceSeg}:`).join(`md:${targetSeg}:`);
      bytes = Buffer.from(text, 'utf8');
    }
    const targetPath = path.join(markdownDir, targetSeg, inner);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, bytes);
    written.push(targetPath);
  }
  return written;
}

/**
 * Best-effort undo for the write phases that run before the database
 * transaction. Each step swallows its own failure so one stuck item cannot
 * block the rest of the cleanup.
 */
async function compensateImport<TTransaction>(
  deps: DataImportDeps<TTransaction>,
  input: { tenantId: string; subjectId: string; progress: ImportProgress },
): Promise<void> {
  const { tenantId, subjectId, progress } = input;
  for (const sessionId of progress.sessionIds) {
    try {
      await deps.sessionStore.deleteSession({ tenant_id: tenantId, session_id: sessionId });
    } catch {
      // Cleanup is best effort; the original error is what the caller sees.
    }
  }
  for (const folderId of progress.folderIds) {
    try {
      await deps.sessionStore.deleteSessionFolder({ tenant_id: tenantId, folder_id: folderId, created_by: subjectId });
    } catch {
      // Best effort, as above.
    }
  }
  for (const personaId of progress.knowledgePersonaIds) {
    try {
      const location = personaKnowledgeLocation({
        knowledgeDir: deps.personaKnowledgeDir,
        tenantId,
        personaId,
      });
      await rm(location.dbPath, { force: true });
      await rm(`${location.dbPath}-wal`, { force: true });
      await rm(`${location.dbPath}-shm`, { force: true });
    } catch {
      // Best effort, as above.
    }
  }
  for (const filePath of progress.memoryFilesWritten) {
    try {
      await rm(filePath, { force: true });
    } catch {
      // Best effort, as above.
    }
  }
  for (const agentId of progress.agentIdsCreated) {
    try {
      await deps.agentStore.deleteAgent({ tenant_id: tenantId, id: agentId });
    } catch {
      // Best effort, as above.
    }
  }
}
