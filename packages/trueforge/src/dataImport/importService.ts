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
import { z } from 'zod';

import { ARCHIVE_MAX_ENTRY_BYTES, formatArchiveBytes } from '../dataExport/archiveLimits';
import { CommonChatExportFileSchema } from '../dataExport/commonChatFormat';
import { EXPORT_SCHEMA_VERSION } from '../dataExport/exportService';
import { sessionPartIndex, sessionPartName } from '../dataExport/sessionRecords';
import { ZIP_MAX_ENTRIES } from '../dataExport/zipStreamWriter';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { ISentinelAuditStore } from '../db/sentinelAuditStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import type { WithTransaction } from '../db/transaction';
import type { ITurnArtifactStore } from '../db/turnArtifactStore';
import { personaKnowledgeLocation } from '../personaKnowledge/knowledgePaths';
import { isAmanGuidePersona } from '../personas/amanGuide/identity';
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
  forEachToolCall,
  ImportAgentsFileSchema,
  ImportAuditFileSchema,
  ImportConnectorsFileSchema,
  ImportFoldersFileSchema,
  ImportManifestSchema,
  ImportPersonalizationFileSchema,
  ImportPersonasFileSchema,
  ImportSchedulesFileSchema,
  ImportSessionEntrySchema,
  ImportSessionPartRecordSchema,
  ImportSettingsFileSchema,
  ImportSpacesFileSchema,
  isToolType,
  LEFT_OUT_PLURALS,
  UnknownToolTypeError,
  withToolTypeResolver,
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
  type ToolType,
  type ToolTypeResolver,
} from './importSchemas';
import { writePersonaKnowledge, type KnowledgeEmbedder } from './knowledgeImport';
import { countingLeftOut, isRecord, type LeftOutCounts } from './lenient';
import { repairPersonaNames } from './personaNames';
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
  /** Checks the archive and reports what an import would bring, writing nothing. */
  dryRun?: boolean;
}

const MEMORY_RETAIN_TIMEOUT_MS = 120_000;
const MAX_LOGGED_ISSUES = 20;
/** Chats or sections whose left-out rows are shown in the summary; the import log has them all. */
const LEFT_OUT_OWNERS_SHOWN = 20;
/** Longest name shown in the left-out table before it is cut short with "...". */
const LEFT_OUT_NAME_SHOWN = 36;
/** Width of the name column in the left-out table, so the counts line up. */
const LEFT_OUT_NAME_COLUMN = 42;
/** Persona name changes shown in the summary; the import log has them all. */
const PERSONA_CHANGES_SHOWN = 20;

const SECTION_OWNERS: Readonly<Record<string, string>> = { 'settings.json': 'Your settings' };

/** One row of the summary's left-out table: whose detail it was, and how many of one kind were left out. */
interface LeftOutRow {
  /** The report's key for the chat or section, so the summary can cap the table by owner, not by row. */
  owner: string;
  name: string;
  count: number;
  /** Singular label, such as "tool detail"; the plural comes from LEFT_OUT_PLURALS. */
  label: string;
}

/** One row per chat or section and kind of internal detail an older version lost. */
function leftOutRows({
  report,
  titles,
}: {
  report: LeftOutReport;
  titles: ReadonlyMap<string, string | null>;
}): LeftOutRow[] {
  const merged: LeftOutByOwner = new Map();
  for (const owners of report.values()) {
    for (const [owner, counts] of owners) {
      const into = merged.get(owner) ?? new Map<string, number>();
      addCounts({ into, counts });
      merged.set(owner, into);
    }
  }
  const rows: LeftOutRow[] = [];
  for (const [owner, counts] of merged) {
    const name = owner.startsWith('chat:')
      ? (titles.get(owner.slice('chat:'.length)) ?? 'Untitled chat')
      : (SECTION_OWNERS[owner.slice('section:'.length)] ?? `The ${owner.slice('section:'.length)} section`);
    for (const [label, count] of counts) {
      if (count > 0) {
        rows.push({ owner, name, count, label });
      }
    }
  }
  return rows;
}

/** A name for the left-out table, cut short with "..." when it is longer than the table shows. */
function leftOutName(name: string): string {
  return name.length > LEFT_OUT_NAME_SHOWN ? `${name.slice(0, LEFT_OUT_NAME_SHOWN - 3)}...` : name;
}

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

/** Who lost an internal detail: `chat:<id>` or `section:<file name>`, with what was lost. */
type LeftOutByOwner = Map<string, Map<string, number>>;

/** Per file read, so a file read again on a later pass replaces what it reported. */
type LeftOutReport = Map<string, LeftOutByOwner>;

function readSectionJson({ files, name }: { files: ReadonlyMap<string, Buffer>; name: string }): unknown {
  const data = files.get(name);
  if (data === undefined) {
    throw new DataImportError(`This export is missing its ${name} section, so nothing was imported.`, 400);
  }
  try {
    const json: unknown = JSON.parse(data.toString('utf8'));
    return json;
  } catch (cause) {
    throw new DataImportError(`The ${name} section of this export is damaged, so nothing was imported.`, 400, {
      cause,
    });
  }
}

function rejectSection({
  name,
  json,
  error,
  logger,
}: {
  name: string;
  json: unknown;
  error: z.ZodError;
  logger: DataImportDeps<never>['logger'];
}): never {
  logRejectedSection({ name, json, error, logger });
  const [first] = error.issues;
  const where = first === undefined ? '' : ` at ${formatIssuePath(first.path)} (${first.code})`;
  throw new DataImportError(`The ${name} section of this export is damaged${where}, so nothing was imported.`, 400, {
    cause: error,
  });
}

/** Where a section failed, by path and issue kind only: the archive's own values never reach the log. */
function logRejectedSection({
  name,
  json,
  error,
  logger,
}: {
  name: string;
  json: unknown;
  error: z.ZodError;
  logger: DataImportDeps<never>['logger'];
}): void {
  const [first] = error.issues;
  const ids = first === undefined || !isSessionsSection(name) ? {} : locateSessionIds(json, first.path);
  logger.warn('Data import rejected an export section', {
    section: name,
    issue_count: error.issues.length,
    issues: error.issues.slice(0, MAX_LOGGED_ISSUES).map(issue => `${formatIssuePath(issue.path)} (${issue.code})`),
    ...ids,
  });
}

function addCounts({ into, counts }: { into: Map<string, number>; counts: LeftOutCounts }): void {
  for (const [label, count] of counts) {
    into.set(label, (into.get(label) ?? 0) + count);
  }
}

function parseSection<TSchema extends z.ZodType>({
  files,
  name,
  schema,
  logger,
  leftOut,
  prepare,
}: {
  files: ReadonlyMap<string, Buffer>;
  name: string;
  schema: TSchema;
  logger: DataImportDeps<never>['logger'];
  leftOut: LeftOutReport;
  /** Brings an older version's values up to today's rules before the strict read. */
  prepare: (json: unknown) => unknown;
}): z.infer<TSchema> {
  const json = prepare(readSectionJson({ files, name }));
  const { result, leftOut: counts } = countingLeftOut(() => schema.safeParse(json));
  if (!result.success) {
    rejectSection({ name, json, error: result.error, logger });
  }
  leftOut.set(name, new Map([[`section:${name}`, new Map(counts)]]));
  return result.data;
}

/** The chat a raw sessions record belongs to, and its title as far as it is known yet. */
function rawChat(item: unknown, titles: ReadonlyMap<string, string | null>): { id: string; title: string | null } {
  const session = isRecord(item) ? item['session'] : undefined;
  const turn = isRecord(item) ? item['turn'] : undefined;
  const fromSession = isRecord(session) && typeof session['session_id'] === 'string' ? session['session_id'] : '';
  const fromTurn = isRecord(turn) && typeof turn['session_id'] === 'string' ? turn['session_id'] : '';
  const id = fromSession === '' ? fromTurn : fromSession;
  const rawTitle = isRecord(session) && typeof session['title'] === 'string' ? session['title'] : null;
  return { id, title: titles.get(id) ?? rawTitle };
}

/** A sessions file read one record at a time, so each detail left out is told against its own chat. */
function parseChatRecords<TSchema extends z.ZodType>({
  files,
  name,
  schema,
  chatOf,
  chats,
  logger,
  leftOut,
}: {
  files: ReadonlyMap<string, Buffer>;
  name: string;
  schema: TSchema;
  chatOf: (record: z.output<TSchema>) => { id: string; title: string | null | undefined };
  chats: ChatReading;
  logger: DataImportDeps<never>['logger'];
  leftOut: LeftOutReport;
}): z.output<TSchema>[] {
  const json = readSectionJson({ files, name });
  const list = z.array(z.unknown()).safeParse(json);
  if (!list.success) {
    rejectSection({ name, json, error: list.error, logger });
  }
  const owners: LeftOutByOwner = new Map();
  const records: z.output<TSchema>[] = [];
  for (const [index, item] of list.data.entries()) {
    let parsed: { result: z.ZodSafeParseResult<z.output<TSchema>>; leftOut: LeftOutCounts };
    try {
      parsed = withToolTypeResolver(chats.resolveToolType, () => countingLeftOut(() => schema.safeParse(item)));
    } catch (cause) {
      if (!(cause instanceof UnknownToolTypeError)) {
        throw cause;
      }
      const chat = rawChat(item, chats.titles);
      throw new DataImportError(
        `Chat '${chat.title ?? 'Untitled chat'}' uses the tool ${cause.toolName}, and this Aman cannot tell what kind of tool it was, so nothing was imported. If the file came from a newer Aman, update this one. Otherwise delete that chat in the Aman it came from, export again and import the new file.`,
        400,
        { cause },
      );
    }
    const { result, leftOut: counts } = parsed;
    if (!result.success) {
      const issues = result.error.issues.map(issue => ({ ...issue, path: [index, ...issue.path] }));
      logRejectedSection({ name, json, error: new z.ZodError(issues), logger });
      const chat = rawChat(item, chats.titles);
      throw new DataImportError(
        `Chat '${chat.title ?? 'Untitled chat'}' in this export has a message this Aman cannot read, so nothing was imported. Export it again from the Aman it came from and import the new file.`,
        400,
        { cause: result.error },
      );
    }
    const chat = chatOf(result.data);
    if (chat.title !== undefined) {
      chats.titles.set(chat.id, chat.title);
    }
    const owner = `chat:${chat.id}`;
    const into = owners.get(owner) ?? new Map<string, number>();
    addCounts({ into, counts });
    owners.set(owner, into);
    records.push(result.data);
  }
  leftOut.set(name, owners);
  return records;
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
  /** Chat titles by id, for telling the person which chat lost a detail. */
  titles: ReadonlyMap<string, string | null>;
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
  /** Internal details from an older version that were repaired or left out, filled in as sections are read. */
  leftOutReport: LeftOutReport;
  /** Persona names and aliases an older version wrote that today's rules changed or dropped. */
  personaRepairLines: string[];
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

/** What reading chat records needs beyond the file: titles seen so far, and how to tell a tool's kind. */
interface ChatReading {
  titles: Map<string, string | null>;
  resolveToolType: ToolTypeResolver;
}

/**
 * Tells the kind of a tool call recorded with a kind this version does not know, from facts and
 * never by guessing: a call to a connector in the export or in this Aman's connector catalog is a
 * connector tool; otherwise every other call to the same tool on the same server in the export must
 * agree on one kind.
 */
function toolTypeResolver({
  files,
  connectorNames,
}: {
  files: ReadonlyMap<string, Buffer>;
  connectorNames: ReadonlySet<string>;
}): ToolTypeResolver {
  let recorded: Map<string, ToolType | 'conflicting'> | undefined;
  const recordedTypes = (): Map<string, ToolType | 'conflicting'> => {
    if (recorded !== undefined) {
      return recorded;
    }
    const found = new Map<string, ToolType | 'conflicting'>();
    for (const [name, data] of files) {
      if (name !== 'sessions.json' && sessionPartIndex(name) === undefined) {
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(data.toString('utf8'));
      } catch {
        // A damaged file is reported by the parse that needs it.
        continue;
      }
      forEachToolCall(json, ({ toolName, serverName, toolInfo }) => {
        const type = toolInfo['type'];
        if (isToolType(type)) {
          const key = toolKey({ serverName, toolName });
          const before = found.get(key);
          found.set(key, before === undefined || before === type ? type : 'conflicting');
        }
      });
    }
    recorded = found;
    return found;
  };
  return ({ toolName, serverName }) => {
    if (serverName !== '' && connectorNames.has(serverName)) {
      return 'mcp';
    }
    const type = recordedTypes().get(toolKey({ serverName, toolName }));
    // A connector tool always names its server, so a call without one is never taken for one.
    if (type === undefined || type === 'conflicting' || (type === 'mcp' && serverName === '')) {
      return undefined;
    }
    return type;
  };
}

/** The same tool name on two servers is two tools. */
function toolKey({ serverName, toolName }: { serverName: string; toolName: string }): string {
  return `${serverName}\u0000${toolName}`;
}

function readSessionEntries(input: {
  files: ReadonlyMap<string, Buffer>;
  logger: DataImportDeps<never>['logger'];
  leftOut: LeftOutReport;
  chats: ChatReading;
}): () => Iterable<ImportSessionEntry> {
  const { files, logger, leftOut, chats } = input;
  const partNames = sessionPartNames(files);
  if (files.has('sessions.json')) {
    if (partNames.length > 0) {
      throw damagedExportError('it holds chats both in sessions.json and in sessions/ files.');
    }
    const entries = parseChatRecords({
      files,
      name: 'sessions.json',
      schema: ImportSessionEntrySchema,
      chatOf: entry => ({ id: entry.session.session_id, title: entry.session.title }),
      chats,
      logger,
      leftOut,
    });
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
        last = {
          name,
          records: parseChatRecords({
            files,
            name,
            schema: ImportSessionPartRecordSchema,
            chatOf: record =>
              record.kind === 'session'
                ? { id: record.session.session_id, title: record.session.title }
                : { id: record.turn.session_id, title: undefined },
            chats,
            logger,
            leftOut,
          }),
        };
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
  /** Connector names this Aman's catalog knows, for telling the kind of a tool call. */
  catalogConnectorNames: ReadonlySet<string>;
  logger: DataImportDeps<never>['logger'];
}): ArchiveContents {
  const { archive, maxBytes, maxEntryBytes, catalogConnectorNames, logger } = input;
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
  const leftOut: LeftOutReport = new Map();
  const section = <TSchema extends z.ZodType>(
    name: string,
    schema: TSchema,
    prepare: (json: unknown) => unknown = json => json,
  ): z.infer<TSchema> => parseSection({ files, name, schema, logger, leftOut, prepare });
  const personaRepairLines: string[] = [];

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
  const connectors = section('connectors.json', ImportConnectorsFileSchema);
  const sessionEntries = readSessionEntries({
    files,
    logger,
    leftOut,
    chats: {
      titles: new Map(),
      resolveToolType: toolTypeResolver({
        files,
        connectorNames: new Set([...catalogConnectorNames, ...connectors.map(connector => connector.name)]),
      }),
    },
  });
  const contents: ArchiveContents = {
    manifest,
    sessions: { ...checkSessions(sessionEntries(), folders), entries: sessionEntries },
    folders,
    agents: section('agents.json', ImportAgentsFileSchema),
    personas: section('personas.json', ImportPersonasFileSchema, json => {
      const repaired = repairPersonaNames(json);
      personaRepairLines.push(...repaired.lines);
      return repaired.json;
    }),
    personalization: section('personalization.json', ImportPersonalizationFileSchema),
    spaces: section('spaces.json', ImportSpacesFileSchema),
    schedules: section('schedules.json', ImportSchedulesFileSchema),
    connectors,
    settings: section('settings.json', ImportSettingsFileSchema),
    // Absent from exports made before permission history travelled.
    audit: files.has('audit.json') ? section('audit.json', ImportAuditFileSchema) : [],
    files,
    sourceTenantId: manifest.tenant_id,
    leftOutReport: leftOut,
    personaRepairLines,
  };
  validateCrossReferences(contents);
  return contents;
}

/** Checks every chat against the folders and itself, in one pass, and keeps what later steps need. */
function checkSessions(
  entries: Iterable<ImportSessionEntry>,
  folders: readonly ImportFolderRecord[],
): Pick<ArchiveSessions, 'ids' | 'agentNames' | 'titles'> {
  const folderIds = new Set<string>();
  for (const folder of folders) {
    if (folderIds.has(folder.folder_id)) {
      throw damagedExportError(`folder ${folder.folder_id} appears twice.`);
    }
    folderIds.add(folder.folder_id);
  }

  const sessionIds = new Set<string>();
  const agentNames = new Set<string>();
  const titles = new Map<string, string | null>();
  for (const entry of entries) {
    const session = entry.session;
    if (sessionIds.has(session.session_id)) {
      throw damagedExportError(`chat ${session.session_id} appears twice.`);
    }
    sessionIds.add(session.session_id);
    titles.set(session.session_id, session.title);
    if (session.agent.type === 'reference' && session.agent.name !== null) {
      agentNames.add(session.agent.name);
    }
    if (session.folder_id !== null && !folderIds.has(session.folder_id)) {
      throw damagedExportError(`chat ${session.session_id} points at a folder that is not in the export.`);
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
    }
    for (const artifact of entry.artifacts) {
      if (artifact.session_id !== session.session_id || !turnIds.has(artifact.turn_id)) {
        throw damagedExportError(
          `a stored file in chat ${session.session_id} points at a turn that is not in the export.`,
        );
      }
    }
  }
  return { ids: [...sessionIds], agentNames, titles };
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
    // Older versions pruned a space's early revisions, so the run may start late; it must still be unbroken.
    const numbers = revisions.map(revision => revision.revision).sort((a, b) => a - b);
    const first = numbers[0] ?? 0;
    const complete =
      numbers.length > 0 &&
      numbers.at(-1) === space.revision &&
      numbers.every((value, index) => value === first + index);
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
  leftOut,
  personaChanges,
  trimmedSpaces,
  dryRun,
}: {
  result: Omit<ImportDataResult, 'summary' | 'schedules_off'>;
  connectorNames: string[];
  auditEntries: number;
  standInAgentNames: string[];
  /** Rows of the left-out table: internal details from an older version that did not come over. */
  leftOut: readonly LeftOutRow[];
  /** One sentence per persona name an older version wrote that today's rules changed or dropped. */
  personaChanges: readonly string[];
  dryRun: boolean;
  /** Spaces whose history starts after revision 1 in the archive. */
  trimmedSpaces: number;
  filesLeftBehind: number;
}): string {
  const counts = [
    `  ${pluralize(result.chats, 'chat', 'chats')}`,
    `  ${pluralize(result.memories, 'memory', 'memories')}`,
    `  ${pluralize(result.personas, 'persona', 'personas')}`,
    `  ${pluralize(result.spaces, 'space', 'spaces')}`,
    `  ${pluralize(result.agents, 'agent', 'agents')}`,
    result.schedules === 0
      ? `  ${pluralize(0, 'schedule', 'schedules')}`
      : `  ${pluralize(result.schedules, 'schedule', 'schedules')} (they will be off)`,
  ];
  const notes: string[] = [];
  if (trimmedSpaces > 0) {
    notes.push(
      trimmedSpaces === 1
        ? '1 space had older history trimmed, so its versions start at 1.'
        : `${String(trimmedSpaces)} spaces had older history trimmed, so their versions start at 1.`,
    );
  }
  if (connectorNames.length > 0) {
    notes.push(`Connectors (${connectorNames.join(', ')}) come without an agent. Attach them on the Agents page.`);
  }
  if (standInAgentNames.length === 1) {
    notes.push(
      `A stand-in agent (${standInAgentNames[0] ?? ''}) was made because a chat or schedule names an agent that is not in the export. Give it a model on the Agents page before you use it.`,
    );
  } else if (standInAgentNames.length > 1) {
    notes.push(
      `Stand-in agents (${standInAgentNames.join(', ')}) were made because chats or schedules name agents that are not in the export. Give each one a model on the Agents page before you use it.`,
    );
  }
  if (filesLeftBehind > 0) {
    notes.push(
      `${pluralize(filesLeftBehind, 'uploaded file was', 'uploaded files were')} left behind because the export did not include ${filesLeftBehind === 1 ? 'it' : 'them'}; the chats still show ${filesLeftBehind === 1 ? 'its name' : 'their names'}.`,
    );
  }
  notes.push('Chats keep their dates and totals. Personas, spaces, folders and schedules show the time of the import.');
  notes.push('Approvals given for one chat only do not carry over.');
  if (auditEntries > 0) {
    notes.push(`${pluralize(auditEntries, 'past permission decision', 'past permission decisions')} came along.`);
  }
  notes.push(
    'Not brought over: model keys, connector sign-ins, your own skills.\n    Add your model again and sign in to your connectors.',
  );
  notes.push('Permissions start fresh, so each tool will ask again.');

  const sections: string[] = [[dryRun ? 'This export has:' : 'Imported:', ...counts].join('\n')];
  if (leftOut.length > 0) {
    const owners: string[] = [];
    for (const row of leftOut) {
      if (!owners.includes(row.owner)) {
        owners.push(row.owner);
      }
    }
    const shown = new Set(owners.slice(0, LEFT_OUT_OWNERS_SHOWN));
    const rows = leftOut
      .filter(row => shown.has(row.owner))
      .map(
        row =>
          `  ${leftOutName(row.name).padEnd(LEFT_OUT_NAME_COLUMN)}${String(row.count)} ${row.count === 1 ? row.label : (LEFT_OUT_PLURALS[row.label] ?? row.label)}`,
      );
    if (owners.length > LEFT_OUT_OWNERS_SHOWN) {
      rows.push(`  And ${String(owners.length - LEFT_OUT_OWNERS_SHOWN)} more. The full list is in the import log.`);
    }
    sections.push(['Left out, from an older version of Aman (your chats are complete):', ...rows].join('\n'));
  }
  if (personaChanges.length > 0) {
    const rows = personaChanges.slice(0, PERSONA_CHANGES_SHOWN).map(change => `  • ${change}`);
    if (personaChanges.length > PERSONA_CHANGES_SHOWN) {
      rows.push(
        `  And ${String(personaChanges.length - PERSONA_CHANGES_SHOWN)} more. The full list is in the import log.`,
      );
    }
    sections.push(["Persona names changed to fit today's rules:", ...rows].join('\n'));
  }
  sections.push(['Good to know:', ...notes.map(note => `  • ${note}`)].join('\n'));
  return sections.join('\n\n');
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
    if (request.dryRun === true) {
      // A dry run never takes the lock, since taking it cleans up after an interrupted import.
      const existing = await readMarkerForRecovery(deps);
      if (existing !== undefined) {
        throw new DataImportError(
          isLiveImportMarker(existing.marker, Date.now())
            ? IMPORT_BUSY_MESSAGE
            : 'An earlier import did not finish, so this file was not checked. Run the import without --dry-run to finish cleaning up, then check again.',
          409,
        );
      }
      return await importArchive(deps, { request, lock: undefined });
    }
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
  /** No lock for a dry run, which writes nothing and returns before the first write. */
  { request, lock }: { request: DataImportRequest; lock: ImportLock<TTransaction> | undefined },
): Promise<ImportDataResult> {
  const { tenantId, subjectId } = request.subject;
  const contents = loadArchive({
    archive: request.archive,
    maxBytes: request.maxBytes,
    maxEntryBytes: request.maxEntryBytes ?? ARCHIVE_MAX_ENTRY_BYTES,
    catalogConnectorNames: new Set(deps.mcpCatalog.list().map(preset => preset.name)),
    logger: deps.logger,
  });
  const {
    manifest,
    sessions,
    folders,
    personas: archivedPersonas,
    personalization,
    spaces,
    schedules,
    settings,
    audit,
  } = contents;
  // Each person's guide is installed from the bundled pack, so the archived copy is never written again.
  // Its memory still maps to the person's own guide, and the summary still counts it.
  const personas = archivedPersonas.filter(({ persona }) => !isAmanGuidePersona(persona));
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
  for (const { persona } of archivedPersonas) {
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
  try {
    await replaySessions(restoreContext, {
      sessions: sessions.entries(),
      folderNames: new Map(folders.map(folder => [folder.folder_id, folder.name])),
    });
  } catch (error) {
    if (error instanceof DataImportError && error.cause instanceof Error) {
      deps.logger.warn('Data import could not read a chat back', {
        error: error.message,
        message: error.cause.message,
        stack: error.cause.stack,
      });
    }
    throw error;
  }

  const leftOut = leftOutRows({ report: contents.leftOutReport, titles: sessions.titles });
  if (leftOut.length > 0) {
    deps.logger.info('Data import left out internal details from an older version', { left_out: leftOut });
  }
  if (contents.personaRepairLines.length > 0) {
    deps.logger.info('Data import repaired persona names from an older version', {
      persona_changes: contents.personaRepairLines,
    });
  }
  const trimmedSpaces = spaces.filter(({ revisions }) => revisions.every(revision => revision.revision > 1)).length;
  if (lock === undefined) {
    const result: Omit<ImportDataResult, 'summary'> = {
      chats: sessions.ids.length,
      memories: memoryCount,
      personas: archivedPersonas.length,
      spaces: spaces.length,
      schedules: schedules.length,
      folders: folders.length,
      agents: agentPlan.archived.length,
      connectors: newConnectors.length,
      schedules_off: schedules.length > 0,
    };
    return {
      ...result,
      summary: buildSummary({
        result,
        connectorNames: newConnectors.map(connector => connector.name),
        auditEntries: audit.length,
        standInAgentNames: agentPlan.placeholders.map(placeholder => placeholder.name),
        filesLeftBehind: 0,
        leftOut,
        personaChanges: contents.personaRepairLines,
        trimmedSpaces,
        dryRun: true,
      }),
    };
  }

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
        // The installer's name stays where the archive has none, since the app offers it only once.
        const ownerName = deps.ownerName === '' ? null : deps.ownerName;
        await deps.personalizationStore.upsertProfile(
          {
            tenant_id: tenantId,
            created_by: subjectId,
            assistant_name: personalization.assistant_name,
            assistant_identity: personalization.assistant_identity,
            voice_guidance: personalization.voice_guidance,
            user_name: personalization.user_name ?? ownerName,
            address_as: personalization.address_as ?? ownerName,
            user_profile: personalization.user_profile,
            pinned_preferences: personalization.pinned_preferences,
            help_areas: personalization.help_areas,
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
        // A run that starts after revision 1 lands renumbered from 1, since a new space starts there.
        for (const [index, revision] of sorted.slice(1).entries()) {
          aggregate = await deps.spaceStore.getAggregate({ tenant_id: tenantId, created_by: subjectId }, tx);
          await deps.spaceStore.updateSpace(
            {
              tenant_id: tenantId,
              created_by: subjectId,
              space_id: space.id,
              ...contentOf(revision),
              expected_revision: index + 1,
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
      personas: archivedPersonas.length,
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
        leftOut,
        personaChanges: contents.personaRepairLines,
        trimmedSpaces,
        dryRun: false,
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
