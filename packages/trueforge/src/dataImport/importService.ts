/**
 * Data import: restores an export archive into a fresh instance.
 *
 * The archive is read strictly (size caps, path rules, every JSON section
 * validated against a Zod schema) and cross-checked before anything is
 * written; the session restore is then replayed against an in-memory store to
 * prove it lands cleanly. Every id the archive would create is checked not to
 * exist yet. Writes then run in a fixed order with the database transaction
 * last: agents, folders and chats, persona knowledge files and memory files are
 * written one by one and recorded as they succeed, so a failure undoes exactly
 * what this run created; the remaining records (personas, personalization,
 * spaces, schedules, connectors, settings, artifacts) commit in one
 * transaction or not at all. A marker setting names the planned writes while
 * they run, and the transaction removes it, so a crash is cleaned up by the
 * next run.
 *
 * Every imported record belongs to the importing user. Ids are kept, so
 * links inside chats keep working. Schedules arrive switched off. Connectors
 * arrive unattached, without credentials, trust marks or search and memory roles;
 * the instance's untouched default web search connector stays as it is.
 * The recall and tool-output screen toggles come along; permission settings
 * and Always allow choices never do, so each tool asks again.
 */
import { AgentSpecSchema, type CreatedBySubject, type ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import { Kysely } from 'kysely';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'winston';
import type { z } from 'zod';

import { ARCHIVE_MAX_ENTRY_BYTES, formatArchiveBytes } from '../dataExport/archiveLimits';
import { CommonChatExportFileSchema } from '../dataExport/commonChatFormat';
import { EXPORT_SCHEMA_VERSION } from '../dataExport/exportService';
import { sessionPartIndex, sessionPartName } from '../dataExport/sessionRecords';
import { ZIP_MAX_ENTRIES } from '../dataExport/zipStreamWriter';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { ISentinelAuditStore } from '../db/sentinelAuditStore';
import { parseTurnCustom, type SessionCustom, type TurnCustom } from '../db/sessionCustom';
import type { WithTransaction } from '../db/transaction';
import type { ITurnArtifactStore } from '../db/turnArtifactStore';
import { personaKnowledgeLocation } from '../personaKnowledge/knowledgePaths';
import { PERSISTED_ARTIFACT_MIME } from '../runtime/artifacts/persistTurnArtifacts';
import type { RetainItem } from '../runtime/memory/hindsightClient';
import {
  applyVaultTombstones,
  CURATED_MEMORY_FILE,
  dailyLogEntries,
  dailyLogFileAt,
  latestTombstonesByEntry,
  parseVaultTombstones,
  personaVaultNamespace,
  VAULT_TOMBSTONES_FILE,
  vaultEntryTimestamp,
  vaultFilesystemNamespace,
} from '../runtime/memory/markdownMemoryFiles';
import { MEMORY_SCREEN_ENABLED_SETTING_KEY } from '../runtime/memoryScreenSettings';
import { MEMORY_SUMMARIZE_SETTING_KEY } from '../runtime/memorySummarizeSettings';
import { DEFAULT_CHAT_MODEL_SETTING_KEY } from '../runtime/tokenFactoryProvider';
import { TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY } from '../runtime/toolOutputScreenSettings';
import type { ImportDataResult } from '../schemas/dataImport';
import { newId } from '../utils/id';
import { detachConnectors, normalizeImportedConnectors, withoutKeptConnector } from './connectorImport';
import { damagedExportError, DataImportError } from './importError';
import {
  compensate,
  emptyLedger,
  findChangedSince,
  ImportLock,
  importMarkerCutoff,
  isLiveImportMarker,
  newImportMarker,
  readImportMarker,
  UnreadableImportMarkerError,
  type ImportLedger,
} from './importLedger';
import {
  assertInstanceEmpty,
  assertNoIdCollisions,
  findDefaultSearchConnector,
  findInstanceData,
  type PreflightDeps,
} from './importPreflight';
import {
  ImportAgentsFileSchema,
  ImportAuditFileSchema,
  ImportConnectorsFileSchema,
  ImportFoldersFileSchema,
  ImportManifestSchema,
  ImportPersonalizationFileSchema,
  ImportPersonasFileSchema,
  ImportSchedulesFileSchema,
  ImportSessionPartFileSchema,
  ImportSessionsFileSchema,
  ImportSettingsFileSchema,
  ImportSpacesFileSchema,
  type ImportAgentRecord,
  type ImportAuditRecord,
  type ImportConnectorRecord,
  type ImportFolderRecord,
  type ImportManifest,
  type ImportPersonalizationFile,
  type ImportPersonasFile,
  type ImportScheduleRecord,
  type ImportSessionEntry,
  type ImportSessionPartRecord,
  type ImportSettingsFile,
  type ImportSpacesFile,
} from './importSchemas';
import { writePersonaKnowledge, type KnowledgeEmbedder } from './knowledgeImport';
import { assembleSessionParts } from './sessionParts';
import { replaySessions, restoreSessions, type SessionRestoreContext } from './sessionRestore';
import { readZipArchive, ZipArchiveError, type ZipArchiveEntry } from './zipArchiveReader';

export interface DataImportDeps<TTransaction> extends PreflightDeps<TTransaction> {
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  /** Permission history is imported with the same commit as the rest, and never removed again. */
  auditStore: Pick<ISentinelAuditStore, 'importRecords'>;
  turnArtifactStore: ITurnArtifactStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  personaKnowledgeDir: string;
  /** Re-indexes persona knowledge; an import that carries knowledge refuses while the model is not ready. */
  knowledgeEmbedder: KnowledgeEmbedder;
  logger: Pick<Logger, 'info' | 'warn'>;
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
  /** Per-file uncompressed cap; defaults to the limit export writes to. */
  maxEntryBytes?: number;
}

const MEMORY_RETAIN_TIMEOUT_MS = 120_000;
const MAX_LOGGED_ISSUES = 20;

/** Instance-wide settings an import may fill in; the permission settings in the archive are never applied. */
const IMPORTABLE_GLOBAL_SETTING_KEYS: ReadonlySet<string> = new Set<string>([
  DEFAULT_CHAT_MODEL_SETTING_KEY,
  MEMORY_SCREEN_ENABLED_SETTING_KEY,
  MEMORY_SUMMARIZE_SETTING_KEY,
  TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY,
]);

const REQUIRED_SECTIONS = [
  'manifest.json',
  'chats.json',
  'folders.json',
  'agents.json',
  'personas.json',
  'personalization.json',
  'spaces.json',
  'schedules.json',
  'connectors.json',
  'settings.json',
] as const;

/** `[3].turns[0].events` style location of a Zod issue; keys and indices only, never the data under them. */
function formatIssuePath(issuePath: readonly PropertyKey[]): string {
  let out = '';
  for (const part of issuePath) {
    if (typeof part === 'number') {
      out += `[${String(part)}]`;
    } else {
      out += out === '' ? String(part) : `.${String(part)}`;
    }
  }
  return out === '' ? 'the top level' : out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The chat and turn ids around an issue in a sessions file, so a log line points at the damaged
 * turn. A sessions.json entry holds a chat and its turns; a sessions/ record holds one or the other.
 */
function locateSessionIds(json: unknown, issuePath: readonly PropertyKey[]): { session_id?: string; turn_id?: string } {
  const [index, turnsKey, turnIndex] = issuePath;
  if (!Array.isArray(json) || typeof index !== 'number') {
    return {};
  }
  const entry: unknown = json[index];
  if (!isRecord(entry)) {
    return {};
  }
  const located: { session_id?: string; turn_id?: string } = {};
  const session = entry['session'];
  const turns = entry['turns'];
  const nestedTurn: unknown =
    turnsKey === 'turns' && typeof turnIndex === 'number' && Array.isArray(turns) ? turns[turnIndex] : undefined;
  const turn = isRecord(nestedTurn) ? nestedTurn['turn'] : entry['turn'];
  if (isRecord(session) && typeof session['session_id'] === 'string') {
    located.session_id = session['session_id'];
  } else if (isRecord(turn) && typeof turn['session_id'] === 'string') {
    located.session_id = turn['session_id'];
  }
  if (isRecord(turn) && typeof turn['turn_id'] === 'string') {
    located.turn_id = turn['turn_id'];
  }
  return located;
}

function isSessionsSection(name: string): boolean {
  return name === 'sessions.json' || sessionPartIndex(name) !== undefined;
}

function parseSection<TSchema extends z.ZodType>({
  files,
  name,
  schema,
  logger,
}: {
  files: ReadonlyMap<string, Buffer>;
  name: string;
  schema: TSchema;
  logger: DataImportDeps<never>['logger'];
}): z.infer<TSchema> {
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
  const result = schema.safeParse(json);
  if (result.success) {
    return result.data;
  }
  const [first] = result.error.issues;
  const ids = first === undefined || !isSessionsSection(name) ? {} : locateSessionIds(json, first.path);
  logger.warn('Data import rejected an export section', {
    section: name,
    issue_count: result.error.issues.length,
    // Paths and issue kinds only: the archive's own values never reach the log.
    issues: result.error.issues
      .slice(0, MAX_LOGGED_ISSUES)
      .map(issue => `${formatIssuePath(issue.path)} (${issue.code})`),
    ...ids,
  });
  const where = first === undefined ? '' : ` at ${formatIssuePath(first.path)} (${first.code})`;
  throw new DataImportError(`The ${name} section of this export is damaged${where}, so nothing was imported.`, 400, {
    cause: result.error,
  });
}

/**
 * The archive's chats. Format 2 spreads them over sessions/ files, which are read again on each
 * pass, so only one file is held at a time; a format 1 sessions.json is read once.
 */
interface ArchiveSessions {
  /** Chat ids in archive order. */
  ids: string[];
  /** Agent names the chats refer to. */
  agentNames: ReadonlySet<string>;
  entries: () => Iterable<ImportSessionEntry>;
}

interface ArchiveContents {
  manifest: ImportManifest;
  sessions: ArchiveSessions;
  folders: ImportFolderRecord[];
  agents: ImportAgentRecord[];
  personas: ImportPersonasFile;
  personalization: ImportPersonalizationFile;
  spaces: ImportSpacesFile;
  schedules: ImportScheduleRecord[];
  connectors: ImportConnectorRecord[];
  settings: ImportSettingsFile;
  audit: ImportAuditRecord[];
  files: ReadonlyMap<string, Buffer>;
  sourceTenantId: string;
}

/** The sessions/ file names in order; a gap in the numbering is a missing file. */
function sessionPartNames(files: ReadonlyMap<string, Buffer>): string[] {
  const indices = [...files.keys()]
    .map(sessionPartIndex)
    .filter(index => index !== undefined)
    .sort((a, b) => a - b);
  return indices.map((index, position) => {
    const expected = sessionPartName(position + 1);
    if (index !== position + 1) {
      throw new DataImportError(`This export is missing its ${expected} section, so nothing was imported.`, 400);
    }
    return expected;
  });
}

function readSessionEntries(input: {
  files: ReadonlyMap<string, Buffer>;
  logger: DataImportDeps<never>['logger'];
}): () => Iterable<ImportSessionEntry> {
  const { files, logger } = input;
  const partNames = sessionPartNames(files);
  if (files.has('sessions.json')) {
    if (partNames.length > 0) {
      throw damagedExportError('it holds chats both in sessions.json and in sessions/ files.');
    }
    const entries = parseSection({ files, name: 'sessions.json', schema: ImportSessionsFileSchema, logger });
    return () => entries;
  }
  if (partNames.length === 0) {
    throw new DataImportError(
      `This export is missing its ${sessionPartName(1)} section, so nothing was imported.`,
      400,
    );
  }
  // The last file read is kept, so an export with one sessions/ file is parsed once for every pass.
  let last: { name: string; records: ImportSessionPartRecord[] } | undefined;
  function* records() {
    for (const name of partNames) {
      if (last?.name !== name) {
        last = { name, records: parseSection({ files, name, schema: ImportSessionPartFileSchema, logger }) };
      }
      yield* last.records;
    }
  }
  return () => assembleSessionParts(records());
}

function loadArchive(input: {
  archive: Buffer;
  maxBytes: number;
  maxEntryBytes: number;
  logger: DataImportDeps<never>['logger'];
}): ArchiveContents {
  const { archive, maxBytes, maxEntryBytes, logger } = input;
  let entries: ZipArchiveEntry[];
  try {
    entries = readZipArchive(archive, {
      maxEntryBytes: Math.min(maxEntryBytes, maxBytes),
      maxTotalBytes: maxBytes,
      maxEntries: ZIP_MAX_ENTRIES,
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
  const section = <TSchema extends z.ZodType>(name: string, schema: TSchema): z.infer<TSchema> =>
    parseSection({ files, name, schema, logger });

  const manifest = section('manifest.json', ImportManifestSchema);
  if (manifest.format !== 'aman-export') {
    throw new DataImportError('This file is not an Aman data export, so nothing was imported.', 400);
  }
  if (manifest.schema_version > EXPORT_SCHEMA_VERSION) {
    throw new DataImportError(
      `This export was made by a newer version of Aman (format version ${String(manifest.schema_version)}). Update Aman, then import again.`,
      400,
    );
  }
  if (manifest.schema_version < 1) {
    throw new DataImportError('This export uses a format version this Aman cannot read, so nothing was imported.', 400);
  }

  // chats.json is validated even though the sessions section is the restore source:
  // a damaged section means the archive cannot be trusted as a whole.
  section('chats.json', CommonChatExportFileSchema);
  const folders = section('folders.json', ImportFoldersFileSchema);
  const sessionEntries = readSessionEntries({ files, logger });
  const contents: ArchiveContents = {
    manifest,
    sessions: { ...checkSessions(sessionEntries(), folders), entries: sessionEntries },
    folders,
    agents: section('agents.json', ImportAgentsFileSchema),
    personas: section('personas.json', ImportPersonasFileSchema),
    personalization: section('personalization.json', ImportPersonalizationFileSchema),
    spaces: section('spaces.json', ImportSpacesFileSchema),
    schedules: section('schedules.json', ImportSchedulesFileSchema),
    connectors: section('connectors.json', ImportConnectorsFileSchema),
    settings: section('settings.json', ImportSettingsFileSchema),
    // Absent from exports made before permission history travelled.
    audit: files.has('audit.json') ? section('audit.json', ImportAuditFileSchema) : [],
    files,
    sourceTenantId: manifest.tenant_id,
  };
  validateCrossReferences(contents);
  return contents;
}

/** Checks every chat against the folders and itself, in one pass, and keeps what later steps need. */
function checkSessions(
  entries: Iterable<ImportSessionEntry>,
  folders: readonly ImportFolderRecord[],
): Pick<ArchiveSessions, 'ids' | 'agentNames'> {
  const folderIds = new Set<string>();
  for (const folder of folders) {
    if (folderIds.has(folder.folder_id)) {
      throw damagedExportError(`folder ${folder.folder_id} appears twice.`);
    }
    folderIds.add(folder.folder_id);
  }

  const sessionIds = new Set<string>();
  const agentNames = new Set<string>();
  for (const entry of entries) {
    const session = entry.session;
    if (sessionIds.has(session.session_id)) {
      throw damagedExportError(`chat ${session.session_id} appears twice.`);
    }
    sessionIds.add(session.session_id);
    if (session.agent.type === 'reference' && session.agent.name !== null) {
      agentNames.add(session.agent.name);
    }
    if (session.folder_id !== null && !folderIds.has(session.folder_id)) {
      throw damagedExportError(`chat ${session.session_id} points at a folder that is not in the export.`);
    }
    const custom = session.custom;
    if (custom !== null && custom !== undefined && !(typeof custom === 'object' && Object.keys(custom).length === 0)) {
      throw damagedExportError(`chat ${session.session_id} has custom data that this version does not store.`);
    }
    const turnIds = new Set<string>();
    for (const { turn } of entry.turns) {
      if (turn.session_id !== session.session_id) {
        throw damagedExportError(`a turn in chat ${session.session_id} belongs to a different chat.`);
      }
      if (turnIds.has(turn.turn_id)) {
        throw damagedExportError(`turn ${turn.turn_id} appears twice in chat ${session.session_id}.`);
      }
      turnIds.add(turn.turn_id);
      try {
        parseTurnCustom(turn.custom ?? null);
      } catch (cause) {
        throw new DataImportError(
          `This export is damaged: a turn in chat ${session.session_id} has custom data that this version does not store. Nothing was imported.`,
          400,
          { cause },
        );
      }
    }
    for (const artifact of entry.artifacts) {
      if (artifact.session_id !== session.session_id || !turnIds.has(artifact.turn_id)) {
        throw damagedExportError(
          `a stored file in chat ${session.session_id} points at a turn that is not in the export.`,
        );
      }
    }
  }
  return { ids: [...sessionIds], agentNames };
}

function validateCrossReferences(contents: ArchiveContents): void {
  const { agents, personas, spaces, schedules, connectors } = contents;

  const agentIds = new Set<string>();
  const agentNames = new Set<string>();
  for (const agent of agents) {
    if (agentIds.has(agent.id) || agentNames.has(agent.name)) {
      throw damagedExportError(`agent ${agent.name} appears twice.`);
    }
    agentIds.add(agent.id);
    agentNames.add(agent.name);
  }

  const personaIds = new Set<string>();
  for (const { persona } of personas) {
    if (personaIds.has(persona.id)) {
      throw damagedExportError(`persona ${persona.id} appears twice.`);
    }
    personaIds.add(persona.id);
  }

  for (const { space, revisions } of spaces) {
    const numbers = revisions.map(revision => revision.revision).sort((a, b) => a - b);
    const complete = numbers.length === space.revision && numbers.every((value, index) => value === index + 1);
    if (!complete) {
      throw damagedExportError(`space ${space.id} is missing some of its revisions.`);
    }
    if (revisions.some(revision => revision.id !== space.id)) {
      throw damagedExportError(`space ${space.id} has a revision that belongs to a different space.`);
    }
  }

  const scheduleIds = new Set<string>();
  const scheduleNames = new Set<string>();
  for (const schedule of schedules) {
    if (scheduleIds.has(schedule.id)) {
      throw damagedExportError(`schedule ${schedule.id} appears twice.`);
    }
    scheduleIds.add(schedule.id);
    const nameKey = `${schedule.agent_name ?? ''}\n${schedule.name}`;
    if (scheduleNames.has(nameKey)) {
      throw damagedExportError(`two schedules named ${schedule.name} appear in the export.`);
    }
    scheduleNames.add(nameKey);
  }

  const connectorNames = new Set<string>();
  for (const connector of connectors) {
    if (connectorNames.has(connector.name)) {
      throw damagedExportError(`connector ${connector.name} appears twice.`);
    }
    connectorNames.add(connector.name);
  }
}

interface ParsedMemoryNamespace {
  seg: string;
  curated: string | undefined;
  entries: { id: string; file: string; text: string; timestamp: string }[];
}

/** Groups the archive's memory/ files by namespace segment and resolves them the way the vault reads them. */
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
    const dailyFile = dailyLogFileAt(inner);
    if (inner === CURATED_MEMORY_FILE) {
      bucket.curated = data.toString('utf8');
    } else if (inner === VAULT_TOMBSTONES_FILE) {
      bucket.tombstones = data.toString('utf8');
    } else if (dailyFile !== undefined) {
      bucket.daily.set(dailyFile, data.toString('utf8'));
    }
  }

  const namespaces: ParsedMemoryNamespace[] = [];
  for (const [seg, bucket] of bySeg) {
    const tombstones = bucket.tombstones === undefined ? [] : parseVaultTombstones(bucket.tombstones);
    const latest = latestTombstonesByEntry(tombstones);
    const scanned = [...bucket.daily.keys()]
      .sort()
      .flatMap(file => dailyLogEntries({ safeNamespace: seg, file, content: bucket.daily.get(file) ?? '' }));
    const entries = applyVaultTombstones(scanned, tombstones).map(entry => {
      const tombstone = latest.get(entry.id);
      return {
        id: entry.id,
        file: entry.file,
        text: entry.text,
        timestamp: tombstone?.action === 'updated' ? tombstone.timestamp : vaultEntryTimestamp(entry),
      };
    });
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
        timestamp: entry.timestamp,
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

function buildSummary({
  result,
  connectorNames,
  auditEntries,
  standInAgentNames,
  filesLeftBehind,
}: {
  result: Omit<ImportDataResult, 'summary' | 'schedules_off'>;
  connectorNames: string[];
  auditEntries: number;
  standInAgentNames: string[];
  filesLeftBehind: number;
}): string {
  const counts = [
    pluralize(result.chats, 'chat', 'chats'),
    pluralize(result.memories, 'memory', 'memories'),
    pluralize(result.personas, 'persona', 'personas'),
    pluralize(result.spaces, 'space', 'spaces'),
    pluralize(result.agents, 'agent', 'agents'),
    result.schedules === 0
      ? pluralize(0, 'schedule', 'schedules')
      : `${pluralize(result.schedules, 'schedule', 'schedules')} (off)`,
  ];
  return [
    `Imported ${counts.join(', ')}.`,
    'Chats keep their dates and totals, but Approve for this chat choices do not carry over; personas, spaces, folders and schedules show the import time.',
    auditEntries === 0
      ? ''
      : `${pluralize(auditEntries, 'permission history entry', 'permission history entries')} came along.`,
    filesLeftBehind === 0
      ? ''
      : `${pluralize(filesLeftBehind, 'uploaded file was', 'uploaded files were')} left behind because the export did not include ${filesLeftBehind === 1 ? 'it' : 'them'}; the chats still show ${filesLeftBehind === 1 ? 'its name' : 'their names'}.`,
    standInAgentNames.length === 0
      ? ''
      : `Also created ${pluralize(standInAgentNames.length, 'stand-in agent', 'stand-in agents')} (${standInAgentNames.join(', ')}) because a chat or schedule refers to an agent the export does not include. Open the Agents page and give each one a model before you use it.`,
    connectorNames.length === 0
      ? ''
      : `Connectors arrive unused, with no agent attached to them: ${connectorNames.join(', ')}. Attach each one to an agent on the Agents page when you want it.`,
    'Not imported: model keys, connector sign-ins and keys, and your own skills and registered repositories.',
    'Permission settings and Always allow choices start fresh, so each tool asks again; re-asking is the safe default.',
  ]
    .filter(part => part !== '')
    .join(' ');
}

interface AgentPlan {
  /** Agents from the archive, created with their own ids. */
  archived: ImportAgentRecord[];
  /** Agents only referenced by name, created as stand-ins so chats and schedules keep their agent. */
  placeholders: { id: string; name: string }[];
  resolve: SessionRestoreContext['resolveAgent'];
}

function planAgents(contents: ArchiveContents): AgentPlan {
  const byId = new Map<string, { id: string; name: string }>();
  const byName = new Map<string, { id: string; name: string }>();
  for (const agent of contents.agents) {
    const target = { id: agent.id, name: agent.name };
    byId.set(agent.id, target);
    byName.set(agent.name, target);
  }
  const referencedNames = new Set<string>();
  for (const schedule of contents.schedules) {
    if (schedule.agent_name !== null) {
      referencedNames.add(schedule.agent_name);
    }
  }
  for (const name of contents.sessions.agentNames) {
    referencedNames.add(name);
  }
  const placeholders: AgentPlan['placeholders'] = [];
  for (const name of referencedNames) {
    if (!byName.has(name)) {
      const placeholder = { id: newId(), name };
      placeholders.push(placeholder);
      byName.set(name, placeholder);
    }
  }
  return {
    archived: contents.agents,
    placeholders,
    resolve: reference => byId.get(reference.id) ?? (reference.name === null ? undefined : byName.get(reference.name)),
  };
}

/** One memory file to write: where it goes under the target tenant, and its bytes. */
interface PlannedMemoryFile {
  targetPath: string;
  bytes: Buffer;
}

/** Maps the archive's memory/ files onto the target tenant's vault paths. Nothing is written here. */
function planMarkdownMemory(
  markdownDir: string,
  contents: ArchiveContents,
  input: { targetTenantId: string; personaSegBySource: ReadonlyMap<string, string> },
): PlannedMemoryFile[] {
  const planned: PlannedMemoryFile[] = [];
  const knownFiles = new Set([CURATED_MEMORY_FILE, VAULT_TOMBSTONES_FILE]);
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
    if (!knownFiles.has(inner) && dailyLogFileAt(inner) === undefined) {
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
    planned.push({ targetPath: path.join(markdownDir, targetSeg, inner), bytes });
  }
  return planned;
}

/** Writes planned files, each created exclusively so an existing file is never replaced. */
async function writeMarkdownMemory(files: readonly PlannedMemoryFile[]): Promise<void> {
  for (const file of files) {
    await mkdir(path.dirname(file.targetPath), { recursive: true });
    await writeFile(file.targetPath, file.bytes, { flag: 'wx' });
  }
}

const IMPORT_BUSY_MESSAGE = 'Another import is already running on this instance. Nothing was changed.';

async function readMarkerForRecovery<TTransaction>(
  deps: DataImportDeps<TTransaction>,
): Promise<Awaited<ReturnType<typeof readImportMarker>>> {
  try {
    return await readImportMarker(deps.globalSettingsStore);
  } catch (cause) {
    if (cause instanceof UnreadableImportMarkerError) {
      throw new DataImportError(
        'An earlier import was interrupted and its record cannot be read, so nothing was changed. Remove this instance, create it again, then import.',
        500,
        { cause },
      );
    }
    throw cause;
  }
}

/**
 * Takes the instance-wide import lock. When an earlier run was interrupted,
 * its leftovers are removed first, but only while nothing has been added or
 * changed since it stopped; otherwise nothing is removed and the run refuses.
 */
async function acquireImportLock<TTransaction>(
  deps: DataImportDeps<TTransaction>,
  input: {
    tenantId: string;
    subjectId: string;
    scope: { created_by_subject_id: string; agent_ids: readonly string[] };
  },
): Promise<ImportLock<TTransaction>> {
  const { tenantId, subjectId, scope } = input;
  const store = deps.globalSettingsStore;
  const fresh = newImportMarker({ tenantId, subjectId });
  const claimed = await ImportLock.claim(store, { marker: fresh, replacing: null });
  if (claimed !== undefined) {
    return claimed;
  }
  const existing = await readMarkerForRecovery(deps);
  if (existing === undefined || isLiveImportMarker(existing.marker, Date.now())) {
    throw new DataImportError(IMPORT_BUSY_MESSAGE, 409);
  }

  const { marker, raw } = existing;
  const leftovers = { tenantId: marker.tenant_id, subjectId: marker.subject_id, ledger: marker.planned };
  const found = await findInstanceData(deps, { tenantId, subjectId, scope, ignoring: marker.planned });
  const changed = await findChangedSince(deps, { ...leftovers, cutoff: importMarkerCutoff(marker) });
  if (found.length > 0 || changed.length > 0) {
    deps.logger.warn('Kept the leftovers of an interrupted data import because the instance was used since', {
      started_at: marker.started_at,
      found,
      changed: changed.slice(0, 5),
    });
    throw new DataImportError(
      'An earlier import was interrupted, and this instance has been used since then, so nothing was removed and nothing was imported. ' +
        'To bring this export in, remove this instance, create it again, then import.',
      409,
    );
  }

  const lock = await ImportLock.claim(store, {
    marker: {
      started_at: marker.started_at,
      heartbeat_at: new Date().toISOString(),
      tenant_id: marker.tenant_id,
      subject_id: marker.subject_id,
      planned: marker.planned,
    },
    replacing: raw,
  });
  if (lock === undefined) {
    throw new DataImportError(IMPORT_BUSY_MESSAGE, 409);
  }
  try {
    const failures = await compensate(deps, leftovers);
    if (failures.length > 0) {
      lock.keepForCleanup();
      throw new DataImportError(
        `An earlier import was interrupted and some of what it wrote could not be removed (${failures.slice(0, 5).join(', ')}). Nothing else was changed; run the import again to retry the cleanup.`,
        500,
      );
    }
    await lock.replace(fresh);
  } catch (cause) {
    await lock.end();
    throw cause;
  }
  deps.logger.info('Removed the leftovers of an interrupted data import', { started_at: marker.started_at });
  return lock;
}

/** Imports for one tenant in this process never overlap; the marker keeps other processes out. */
const importsInFlight = new Set<string>();

export async function runDataImport<TTransaction>(
  deps: DataImportDeps<TTransaction>,
  request: DataImportRequest,
): Promise<ImportDataResult> {
  const { tenantId, subjectId } = request.subject;
  if (request.archive.byteLength > request.maxBytes) {
    throw new DataImportError(
      `The export file is ${formatArchiveBytes(request.archive.byteLength)}, over the ${formatArchiveBytes(request.maxBytes)} limit for an import. Export again without uploaded files.`,
      400,
    );
  }
  if (importsInFlight.has(tenantId)) {
    throw new DataImportError(IMPORT_BUSY_MESSAGE, 409);
  }
  importsInFlight.add(tenantId);
  try {
    const scope = { created_by_subject_id: subjectId, agent_ids: request.subject.agentIds };
    const lock = await acquireImportLock(deps, { tenantId, subjectId, scope });
    try {
      return await importArchive(deps, { request, lock });
    } finally {
      await lock.end();
    }
  } finally {
    importsInFlight.delete(tenantId);
  }
}

async function importArchive<TTransaction>(
  deps: DataImportDeps<TTransaction>,
  { request, lock }: { request: DataImportRequest; lock: ImportLock<TTransaction> },
): Promise<ImportDataResult> {
  const { tenantId, subjectId } = request.subject;
  const contents = loadArchive({
    archive: request.archive,
    maxBytes: request.maxBytes,
    maxEntryBytes: request.maxEntryBytes ?? ARCHIVE_MAX_ENTRY_BYTES,
    logger: deps.logger,
  });
  const { manifest, sessions, folders, personas, personalization, spaces, schedules, settings, audit } = contents;
  const connectors = normalizeImportedConnectors(contents.connectors);
  const connectorNames = new Set(connectors.map(connector => connector.name));
  const importerSubject: CreatedBySubject = {
    subject_id: subjectId,
    subject_type: 'user',
    subject_display_name: request.subject.subjectDisplayName,
  };
  const scope = { created_by_subject_id: subjectId, agent_ids: request.subject.agentIds };

  // --- Reads only: nothing is written until every check below has passed. ---
  await assertInstanceEmpty(deps, { tenantId, subjectId, scope });
  const newConnectors = withoutKeptConnector({
    connectors,
    kept: await findDefaultSearchConnector(deps, tenantId),
  });

  const agentPlan = planAgents(contents);
  await assertNoIdCollisions(deps, {
    tenantId,
    subjectId,
    ids: {
      sessionIds: sessions.ids,
      folderIds: folders.map(folder => folder.folder_id),
      personas: personas.map(entry => entry.persona),
      spaceIds: spaces.map(entry => entry.space.id),
      scheduleIds: schedules.map(schedule => schedule.id),
      agents: [...agentPlan.archived, ...agentPlan.placeholders],
    },
  });

  const knowledgePlan = personas.flatMap(({ persona, knowledge }) =>
    knowledge.documents.length === 0
      ? []
      : [
          {
            personaId: persona.id,
            documents: knowledge.documents,
            dbPath: personaKnowledgeLocation({
              knowledgeDir: deps.personaKnowledgeDir,
              tenantId,
              personaId: persona.id,
            }).dbPath,
          },
        ],
  );
  for (const library of knowledgePlan) {
    if (existsSync(library.dbPath)) {
      throw new DataImportError(
        `A knowledge library for persona ${library.personaId} already exists on this instance, so the import was refused and nothing was changed.`,
        409,
      );
    }
  }
  const hasKnowledgeText = knowledgePlan.some(library =>
    library.documents.some(document => document.chunks.length > 0),
  );
  if (hasKnowledgeText && !(await deps.knowledgeEmbedder.ensureReady())) {
    throw new DataImportError(
      'The knowledge index is still downloading, retry in a few minutes. Nothing was imported.',
      503,
    );
  }

  const personaSegBySource = new Map<string, string>();
  const personaWireBySourceSeg = new Map<string, string>();
  for (const { persona } of personas) {
    const wire = personaVaultNamespace(persona.display_name);
    const sourceSeg = vaultFilesystemNamespace(contents.sourceTenantId, wire);
    personaSegBySource.set(sourceSeg, vaultFilesystemNamespace(tenantId, wire));
    personaWireBySourceSeg.set(sourceSeg, wire);
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
  const plannedMemoryFiles =
    deps.memoryTarget.kind === 'markdown'
      ? planMarkdownMemory(deps.memoryTarget.markdownDir, contents, { targetTenantId: tenantId, personaSegBySource })
      : [];
  for (const file of plannedMemoryFiles) {
    if (existsSync(file.targetPath)) {
      throw new DataImportError(
        'A memory file from this export already exists on this instance, so the import was refused and nothing was changed.',
        409,
      );
    }
  }

  // Replay the session restore in memory: proves the decomposition lands before real writes begin.
  const restoreContext: SessionRestoreContext = {
    tenantId,
    subject: importerSubject,
    resolveAgent: agentPlan.resolve,
    connectorNames,
  };
  for (const schedule of schedules) {
    if (agentPlan.resolve({ id: schedule.agent_id, name: schedule.agent_name }) === undefined) {
      throw new DataImportError(
        'A schedule in this export names an agent that is not in the export, so nothing was imported.',
        400,
      );
    }
  }
  await replaySessions(restoreContext, {
    sessions: sessions.entries(),
    folderNames: new Map(folders.map(folder => [folder.folder_id, folder.name])),
  });

  // --- Writes. The marker names everything planned before the first one lands. ---
  const planned: ImportLedger = {
    agent_ids: [...agentPlan.archived, ...agentPlan.placeholders].map(agent => agent.id),
    folder_ids: folders.map(folder => folder.folder_id),
    session_ids: sessions.ids,
    knowledge_db_paths: knowledgePlan.map(library => library.dbPath),
    memory_files: plannedMemoryFiles.map(file => file.targetPath),
  };
  await lock.replace({ ...newImportMarker({ tenantId, subjectId }), planned });
  const created = emptyLedger();

  try {
    for (const agent of agentPlan.archived) {
      await deps.agentStore.createAgent({
        id: agent.id,
        tenant_id: tenantId,
        name: agent.name,
        description: agent.description,
        manifest: detachConnectors({ spec: agent.manifest, names: connectorNames }),
        external_id: agent.external_id,
        host_managed: agent.host_managed,
        created_by_subject: importerSubject,
      });
      created.agent_ids.push(agent.id);
    }
    for (const placeholder of agentPlan.placeholders) {
      await deps.agentStore.createAgent({
        id: placeholder.id,
        tenant_id: tenantId,
        name: placeholder.name,
        description:
          'Created by data import so imported schedules and chats keep their agent name. Set the model and instructions before use.',
        manifest: AgentSpecSchema.parse({
          model: { name: 'imported/unconfigured' },
          instructions: 'This agent was created by a data import. Set its instructions before use.',
        }),
        external_id: null,
        host_managed: false,
        created_by_subject: importerSubject,
      });
      created.agent_ids.push(placeholder.id);
    }

    for (const folder of folders) {
      await deps.sessionStore.createSessionFolder({
        tenant_id: tenantId,
        folder_id: folder.folder_id,
        created_by: subjectId,
        name: folder.name,
      });
      created.folder_ids.push(folder.folder_id);
    }
    await restoreSessions(
      deps.sessionStore,
      { ...restoreContext, onSessionCreated: sessionId => created.session_ids.push(sessionId) },
      sessions.entries(),
    );

    for (const library of knowledgePlan) {
      await writePersonaKnowledge({
        knowledgeDir: deps.personaKnowledgeDir,
        tenantId,
        personaId: library.personaId,
        documents: library.documents,
        embedder: deps.knowledgeEmbedder,
      });
    }

    if (deps.memoryTarget.kind === 'markdown') {
      await writeMarkdownMemory(plannedMemoryFiles);
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

    // --- Everything else commits in one transaction, together with the removal of the marker. ---
    let connectorsImported = 0;
    let filesLeftBehind = 0;
    await lock.pauseRenewal();
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

      if (!(tx instanceof Kysely)) {
        throw new Error('The import transaction is not a database transaction.');
      }
      await deps.auditStore.importRecords({ tenant_id: tenantId, created_by: subjectId, records: audit }, tx);

      if (personalization !== null) {
        // Replaces the empty profile the app creates on first sign-in; the emptiness check ruled out a filled one.
        await deps.personalizationStore.upsertProfile(
          {
            tenant_id: tenantId,
            created_by: subjectId,
            assistant_name: personalization.assistant_name,
            assistant_identity: personalization.assistant_identity,
            voice_guidance: personalization.voice_guidance,
            user_name: personalization.user_name,
            address_as: personalization.address_as,
            user_profile: personalization.user_profile,
            pinned_preferences: personalization.pinned_preferences,
            learned_profile: personalization.learned_profile,
            learning_enabled: personalization.learning_enabled,
            updated_by: subjectId,
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
        const agent = agentPlan.resolve({ id: schedule.agent_id, name: schedule.agent_name });
        if (agent === undefined) {
          throw new DataImportError('A schedule in this export names an agent that could not be restored.', 400);
        }
        await deps.scheduleStore.createScheduleAndRun(
          {
            id: schedule.id,
            tenant_id: tenantId,
            agent_id: agent.id,
            agent_name: agent.name,
            name: schedule.name,
            // Personas keep their ids on import; one the export did not carry runs as the agent's own assistant.
            persona_id:
              schedule.persona_id !== null && personas.some(({ persona }) => persona.id === schedule.persona_id)
                ? schedule.persona_id
                : null,
            manifest: { ...schedule.manifest, status: 'paused' },
            created_by_subject: importerSubject,
            runFrom: new Date(),
          },
          tx,
        );
      }

      for (const connector of newConnectors) {
        await deps.mcpServerStore.createServer(
          {
            tenant_id: tenantId,
            name: connector.name,
            manifest: connector.manifest,
            first_party: false,
          },
          tx,
        );
        connectorsImported += 1;
      }

      for (const setting of settings.instance) {
        if (!IMPORTABLE_GLOBAL_SETTING_KEYS.has(setting.key)) {
          continue;
        }
        // The instance's own value wins: the old deployment's default model may not exist here.
        if ((await deps.globalSettingsStore.getSetting({ key: setting.key }, tx)) === undefined) {
          await deps.globalSettingsStore.setSetting({ key: setting.key, value: setting.value }, tx);
        }
      }

      for (const entry of sessions.entries()) {
        for (const activation of entry.persona_activations) {
          await deps.personaStore.recordPersonaActivation(
            { tenant_id: tenantId, session_id: entry.session.session_id, ...activation },
            tx,
          );
        }
        for (const artifact of entry.artifacts) {
          const identity = {
            tenant_id: tenantId,
            session_id: artifact.session_id,
            turn_id: artifact.turn_id,
            path: artifact.path,
          };
          if (artifact.status === 'stored') {
            const blob = artifact.archive_entry === undefined ? undefined : contents.files.get(artifact.archive_entry);
            if (blob !== undefined) {
              // The archive's type is not trusted: an upload is always served as a plain download.
              await deps.turnArtifactStore.recordStoredArtifact(
                { ...identity, name: artifact.name, data: blob, mime: PERSISTED_ARTIFACT_MIME },
                tx,
              );
            } else {
              filesLeftBehind += 1;
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

      await lock.removeIn(tx);
    });
    lock.committed();

    const result: Omit<ImportDataResult, 'summary'> = {
      chats: sessions.ids.length,
      memories: memoryCount,
      personas: personas.length,
      spaces: spaces.length,
      schedules: schedules.length,
      folders: folders.length,
      agents: agentPlan.archived.length,
      connectors: connectorsImported,
      schedules_off: schedules.length > 0,
    };
    return {
      ...result,
      summary: buildSummary({
        result,
        connectorNames: newConnectors.map(connector => connector.name),
        auditEntries: audit.length,
        standInAgentNames: agentPlan.placeholders.map(placeholder => placeholder.name),
        filesLeftBehind,
      }),
    };
  } catch (cause) {
    lock.resumeRenewal();
    // Files are removed by their planned paths (checked absent beforehand); ids only by what this run created.
    const failures = await compensate(deps, {
      tenantId,
      subjectId,
      ledger: { ...created, knowledge_db_paths: planned.knowledge_db_paths, memory_files: planned.memory_files },
    });
    if (failures.length > 0) {
      lock.keepForCleanup();
      throw new DataImportError(
        `The import failed and some of what it wrote could not be removed (${failures.slice(0, 5).join(', ')}). Run the import again to retry the cleanup.`,
        500,
        { cause },
      );
    }
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
