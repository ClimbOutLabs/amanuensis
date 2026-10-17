/**
 * Streams one user's data export archive: one JSON file per section, the
 * memory tree as Markdown, and uploaded files only when requested. Never
 * exported: model providers and their keys, OAuth tokens, registered OAuth
 * clients, approval tokens, always-allow grants, skills and registered
 * repositories, sandbox state, schedule run history, and anything another
 * user owns. The owner's own permission history (audit rows) and each chat's
 * persona choices do travel.
 *
 * Every JSON value and every text file passes both secret layers before it
 * is written. Sections are produced item by item, so peak memory is bounded
 * by the largest single item, not by the size of the instance.
 */
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Writable } from 'node:stream';

import type {
  ISessionStore,
  PersistedTurnEvent,
  SessionRecord,
  TokenPagination,
  TurnRecord,
} from '@truefoundry/trueforge-core/agent-session';

import { errorCode } from '../cli/errorCode';
import type { AgentRecord } from '../db/agentStore';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IMcpServerStore } from '../db/mcpServerStore';
import type { IPersonalizationStore } from '../db/personalizationStore';
import type { IPersonaStore } from '../db/personaStore';
import type { IScheduleStore } from '../db/scheduleStore';
import type { ISentinelAuditStore } from '../db/sentinelAuditStore';
import type { ISentinelSettingsStore } from '../db/sentinelSettingsStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import type { ISpaceStore } from '../db/spaceStore';
import type { ITurnArtifactStore, TurnArtifactRecord } from '../db/turnArtifactStore';
import { personaKnowledgeLocation } from '../personaKnowledge/knowledgePaths';
import { openPersonaKnowledgeRepository } from '../personaKnowledge/sqliteKnowledgeRepository';
import type { Persona } from '../personas/persona';
import {
  CURATED_MEMORY_FILE,
  DAILY_LOG_FILE_PATTERN,
  VAULT_TOMBSTONES_FILE,
  personaForVaultFilesystemNamespace,
  personaVaultNamespace,
  sanitizeNamespace,
  vaultFilesystemNamespace,
  vaultWriteNamespace,
} from '../runtime/memory/markdownMemoryFiles';
import type { MemoryClient } from '../runtime/memory/memoryClient';
import { MEMORY_SCREEN_ENABLED_SETTING_KEY } from '../runtime/memoryScreenSettings';
import { MEMORY_SUMMARIZE_SETTING_KEY } from '../runtime/memorySummarizeSettings';
import { DEFAULT_CHAT_MODEL_SETTING_KEY } from '../runtime/tokenFactoryProvider';
import { TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY } from '../runtime/toolOutputScreenSettings';
import { sessionToCommonChat } from './chatMapping';
import type { CommonChat } from './commonChatFormat';
import { createExportScrubber, type ExportScrubber } from './secretScrub';
import { exportableEvents, withoutDeploymentBoundFields } from './sessionRecords';
import { ZipStreamWriter } from './zipStreamWriter';

export const EXPORT_FORMAT = 'aman-export';
export const EXPORT_SCHEMA_VERSION = 1;

const PAGE_LIMIT = 200;

/** Persona choices read per chat; a chat records one per turn at most. */
const PERSONA_ACTIVATION_LIMIT = 100_000;

/** Same bound the memory vault API uses for one list call. */
const MEMORY_LIST_TIMEOUT_MS = 10_000;

/** Instance-wide, non-secret toggles. Anything not listed here never leaves in settings.json. */
export const EXPORTED_GLOBAL_SETTING_KEYS = [
  DEFAULT_CHAT_MODEL_SETTING_KEY,
  MEMORY_SCREEN_ENABLED_SETTING_KEY,
  MEMORY_SUMMARIZE_SETTING_KEY,
  TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY,
] as const;

export interface ExportSubject {
  tenantId: string;
  subjectId: string;
  includeUploads: boolean;
  /**
   * Memory vaults and settings that belong to the whole instance (the shared and topic vaults,
   * the global toggles) rather than to one user. Set for administrators and for an instance
   * without sign-in; off, only the user's own persona vaults and settings are exported.
   */
  includeInstanceData: boolean;
}

/**
 * Where memory comes from: the Markdown backend is read from its files
 * verbatim; any other backend is read through its MemoryClient and rendered
 * into Markdown files in the same layout. `unavailable` is a backend that is
 * selected but not set up (no provider), which skips memory with a note.
 */
export type MemoryExportSource =
  | { kind: 'markdown'; markdownDir: string }
  | { kind: 'client'; backend: string; client: Pick<MemoryClient, 'listEntries'> }
  | { kind: 'unavailable'; backend: string; reason: string };

export interface DataExportDeps<TTransaction> {
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  personaStore: IPersonaStore<TTransaction>;
  personalizationStore: IPersonalizationStore<TTransaction>;
  spaceStore: ISpaceStore<TTransaction>;
  scheduleStore: IScheduleStore<TTransaction>;
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  sentinelSettingsStore: ISentinelSettingsStore<TTransaction>;
  auditStore: Pick<ISentinelAuditStore, 'listOwned'>;
  turnArtifactStore: ITurnArtifactStore<TTransaction>;
  mcpServerStore: IMcpServerStore<TTransaction>;
  /** The agents the user may manage; the entry point resolves them because access rules differ per deployment. */
  listAgents: () => Promise<readonly AgentRecord[]>;
  memorySource: MemoryExportSource;
  /** Root dir of the per-persona knowledge SQLite files. */
  personaKnowledgeDir: string;
}

export interface DataExportRequest {
  subject: ExportSubject;
  /** Exact secret values to remove (see `normalizeSecrets`). */
  secrets: readonly string[];
  exportedAt: Date;
  appVersion: string;
  maxBytes: number;
}

export interface DataExportResult {
  bytesWritten: number;
  entries: number;
  redactions: number;
}

interface MemoryReport {
  backend: string;
  status: 'included' | 'skipped';
  /** Vault count that went into the archive. */
  vaults: number;
  /** Instance-wide vaults were left out because the caller is not an administrator. */
  shared_vaults_included: boolean;
  note?: string;
}

interface ExportContext<TTransaction> {
  deps: DataExportDeps<TTransaction>;
  zip: ZipStreamWriter;
  scrub: ExportScrubber;
  request: DataExportRequest;
  /** Top-level JSON sections written so far, in order. */
  sections: string[];
}

async function* paged<T>(
  fetchPage: (pageToken: string | undefined) => Promise<{ data: T[]; pagination: TokenPagination }>,
): AsyncGenerator<T> {
  let pageToken: string | undefined;
  for (;;) {
    const page = await fetchPage(pageToken);
    yield* page.data;
    if (page.pagination.next_page_token === undefined) {
      return;
    }
    pageToken = page.pagination.next_page_token;
  }
}

/** Normalizes a store record to plain JSON (Dates become ISO strings) before scrubbing. */
function toPlainJson(value: unknown): unknown {
  const plain: unknown = JSON.parse(JSON.stringify(value));
  return plain;
}

async function writeJsonArrayEntry<TTransaction>(
  context: ExportContext<TTransaction>,
  name: string,
  items: Iterable<unknown> | AsyncIterable<unknown>,
): Promise<void> {
  context.sections.push(name);
  await context.zip.addEntry(name, async sink => {
    await sink.writeText('[\n');
    let first = true;
    for await (const item of items) {
      const json = JSON.stringify(context.scrub.json(toPlainJson(item)));
      await sink.writeText(first ? json : `,\n${json}`);
      first = false;
    }
    await sink.writeText(first ? ']' : '\n]');
  });
}

async function writeJsonEntry<TTransaction>(
  context: ExportContext<TTransaction>,
  name: string,
  value: unknown,
): Promise<void> {
  context.sections.push(name);
  await context.zip.addTextEntry(name, JSON.stringify(context.scrub.json(toPlainJson(value)), null, 2));
}

async function listAllTurns<TTransaction>(
  deps: DataExportDeps<TTransaction>,
  sessionId: string,
): Promise<TurnRecord<TurnCustom>[]> {
  const summaries = paged(pageToken =>
    deps.sessionStore.listTurns({ session_id: sessionId, limit: PAGE_LIMIT, page_token: pageToken }),
  );
  const turns: TurnRecord<TurnCustom>[] = [];
  for await (const summary of summaries) {
    const full = await deps.sessionStore.getTurn({ session_id: sessionId, turn_id: summary.turn_id });
    if (full !== undefined) {
      turns.push(full);
    }
  }
  return turns;
}

export async function runDataExport<TTransaction>(
  deps: DataExportDeps<TTransaction>,
  request: DataExportRequest,
  out: Writable,
): Promise<DataExportResult> {
  const { subject } = request;
  const { tenantId, subjectId } = subject;
  const zip = new ZipStreamWriter(out, { maxBytes: request.maxBytes });
  const scrub = createExportScrubber(request.secrets);
  const context: ExportContext<TTransaction> = { deps, zip, scrub, request, sections: [] };
  // Only what this user created: no agent-bound sessions or schedules of other users.
  const ownScope = { created_by_subject_id: subjectId, agent_ids: [] };

  const folders = await deps.sessionStore.listSessionFolders({ tenant_id: tenantId, created_by: subjectId });
  const folderNameById = new Map(folders.map(folder => [folder.folder_id, folder.name]));
  const personas = await deps.personaStore.listPersonas({ tenant_id: tenantId, created_by: subjectId });

  function sessionStream(): AsyncGenerator<SessionRecord<SessionCustom>> {
    return paged(pageToken =>
      deps.sessionStore.listSessions({
        tenant_id: tenantId,
        limit: PAGE_LIMIT,
        page_token: pageToken,
        order: 'asc',
        start_timestamp: undefined,
        end_timestamp: undefined,
        agent_id: undefined,
        created_by_or_agent_ids: ownScope,
        metadata: undefined,
        source_type: undefined,
        source_id: undefined,
      }),
    );
  }

  // chats.json: the common chat format.
  async function* chats(): AsyncGenerator<CommonChat> {
    for await (const session of sessionStream()) {
      const turns = await listAllTurns(deps, session.session_id);
      yield sessionToCommonChat({
        session,
        turns,
        folderName: session.folder_id === null ? undefined : folderNameById.get(session.folder_id),
      });
    }
  }
  await writeJsonArrayEntry(context, 'chats.json', chats());

  // sessions.json: full fidelity (turns with snapshots, per-turn events, artifact index).
  const uploadedBlobs: { sessionId: string; artifact: TurnArtifactRecord }[] = [];
  async function* sessions(): AsyncIterable<unknown> {
    for await (const session of sessionStream()) {
      const turns = await listAllTurns(deps, session.session_id);
      const turnsWithEvents: unknown[] = [];
      const artifacts: TurnArtifactRecord[] = [];
      for (const turn of turns) {
        const events = paged(pageToken =>
          deps.sessionStore.listTurnEvents({
            session_id: session.session_id,
            turn_id: turn.turn_id,
            limit: PAGE_LIMIT,
            page_token: pageToken,
            order: 'asc',
          }),
        );
        const eventList: PersistedTurnEvent[] = [];
        for await (const event of events) {
          eventList.push(event);
        }
        turnsWithEvents.push({ turn, events: exportableEvents(eventList) });
        artifacts.push(
          ...(await deps.turnArtifactStore.listArtifacts({
            tenant_id: tenantId,
            session_id: session.session_id,
            turn_id: turn.turn_id,
          })),
        );
      }
      // Artifact rows are write-once, so their last change is their creation.
      const artifactRows = artifacts.map(artifact => ({ ...artifact, updated_at: artifact.created_at }));
      // Newest first in the store; the archive keeps them oldest first so a replay lands in order.
      const personaActivations = (
        await deps.personaStore.listSessionPersonaActivations({
          tenant_id: tenantId,
          session_id: session.session_id,
          limit: PERSONA_ACTIVATION_LIMIT,
        })
      ).reverse();
      yield withoutDeploymentBoundFields(
        toPlainJson({
          session,
          turns: turnsWithEvents,
          artifacts: artifactRows,
          persona_activations: personaActivations,
        }),
      );
      if (subject.includeUploads) {
        uploadedBlobs.push(...artifacts.map(artifact => ({ sessionId: session.session_id, artifact })));
      }
    }
  }
  await writeJsonArrayEntry(context, 'sessions.json', sessions());

  await writeJsonArrayEntry(context, 'folders.json', folders);

  // personas.json: personas with their knowledge documents and chunk text.
  function* personaEntries(): Iterable<unknown> {
    for (const persona of personas) {
      yield { persona, knowledge: readPersonaKnowledge(deps, tenantId, persona) };
    }
  }
  await writeJsonArrayEntry(context, 'personas.json', personaEntries());

  const profile = await deps.personalizationStore.getProfile({ tenant_id: tenantId, created_by: subjectId });
  await writeJsonEntry(context, 'personalization.json', profile ?? null);

  // spaces.json: each space with every revision.
  async function* spaceEntries(): AsyncIterable<unknown> {
    let offset = 0;
    for (;;) {
      const page = await deps.spaceStore.listSpaces({
        tenant_id: tenantId,
        created_by: subjectId,
        status: undefined,
        limit: PAGE_LIMIT,
        offset,
      });
      for (const space of page) {
        const revisions: unknown[] = [];
        for (let revision = 1; revision <= space.revision; revision += 1) {
          const record = await deps.spaceStore.getSpaceRevision({
            tenant_id: tenantId,
            created_by: subjectId,
            space_id: space.id,
            revision,
          });
          if (record !== undefined) {
            revisions.push(record);
          }
        }
        yield { space, revisions };
      }
      if (page.length < PAGE_LIMIT) {
        return;
      }
      offset += page.length;
    }
  }
  await writeJsonArrayEntry(context, 'spaces.json', spaceEntries());

  // agents.json: full definitions, so imported schedules point at the real agents.
  await writeJsonArrayEntry(context, 'agents.json', await deps.listAgents());

  // schedules.json: the user's own definitions only, never run history.
  const schedules = paged(pageToken =>
    deps.scheduleStore.listSchedules({
      tenant_id: tenantId,
      limit: PAGE_LIMIT,
      page_token: pageToken,
      agent_names: undefined,
      created_by_or_agent_ids: ownScope,
    }),
  );
  await writeJsonArrayEntry(context, 'schedules.json', schedules);

  // connectors.json: connector entries with no credentials. A dcr auth block holds no secret, so its marker stays
  // and the imported connector asks for sign-in; header and client-id blocks are removed whole.
  async function* connectorEntries(): AsyncIterable<unknown> {
    const servers = await deps.mcpServerStore.listServers({ tenant_id: tenantId, names: undefined });
    for (const server of servers) {
      const manifest = { ...server.manifest };
      if (manifest.auth?.type === 'dcr') {
        manifest.auth = { type: 'dcr' };
      } else {
        delete manifest.auth;
      }
      yield {
        id: server.id,
        name: server.name,
        first_party: server.first_party,
        created_at: server.created_at,
        updated_at: server.updated_at,
        manifest: { ...manifest, url: scrub.url(manifest.url) },
      };
    }
  }
  await writeJsonArrayEntry(context, 'connectors.json', connectorEntries());

  // settings.json: the caller's own permission settings, plus instance toggles for administrators.
  const permissionSettings = await deps.sentinelSettingsStore.get({ tenant_id: tenantId, created_by: subjectId });
  const instanceSettings: { key: string; value: string }[] = [];
  if (subject.includeInstanceData) {
    for (const key of EXPORTED_GLOBAL_SETTING_KEYS) {
      const record = await deps.globalSettingsStore.getSetting({ key });
      if (record !== undefined) {
        instanceSettings.push({ key, value: record.value });
      }
    }
  }
  await writeJsonEntry(context, 'settings.json', {
    permission_settings: permissionSettings,
    instance: instanceSettings,
  });

  // audit.json: this user's permission history, oldest first.
  async function* auditEntries(): AsyncIterable<unknown> {
    for (let offset = 0; ; offset += PAGE_LIMIT) {
      const page = await deps.auditStore.listOwned({
        tenant_id: tenantId,
        created_by: subjectId,
        limit: PAGE_LIMIT,
        offset,
      });
      yield* page;
      if (page.length < PAGE_LIMIT) {
        return;
      }
    }
  }
  await writeJsonArrayEntry(context, 'audit.json', auditEntries());

  const memory = await writeMemoryEntries(context, personas);

  if (subject.includeUploads) {
    for (const { sessionId, artifact } of uploadedBlobs) {
      await writeUploadedFile(context, { sessionId, artifact });
    }
  }

  // Last, so the redaction count covers every section.
  const manifest = {
    format: EXPORT_FORMAT,
    schema_version: EXPORT_SCHEMA_VERSION,
    exported_at: request.exportedAt.toISOString(),
    app_version: request.appVersion,
    tenant_id: tenantId,
    include_uploads: subject.includeUploads,
    sections: context.sections,
    redactions: scrub.redactionCount(),
    memory,
  };
  await zip.addTextEntry('manifest.json', JSON.stringify(scrub.json(manifest), null, 2));

  await zip.finish();
  return { bytesWritten: zip.bytesWritten, entries: zip.entryCount, redactions: scrub.redactionCount() };
}

function readPersonaKnowledge<TTransaction>(
  deps: DataExportDeps<TTransaction>,
  tenantId: string,
  persona: Persona,
): { documents: unknown[] } {
  const location = personaKnowledgeLocation({
    knowledgeDir: deps.personaKnowledgeDir,
    tenantId,
    personaId: persona.id,
  });
  if (!existsSync(location.dbPath)) {
    return { documents: [] };
  }
  const repository = openPersonaKnowledgeRepository({ dbPath: location.dbPath });
  try {
    const documents = repository.listDocuments().map(document => ({
      ...document,
      chunks: repository
        .listDocumentChunks({ documentId: document.id })
        .map(chunk => ({ chunk_index: chunk.chunkIndex, text: chunk.text })),
    }));
    return { documents };
  } finally {
    repository.close();
  }
}

async function writeUploadedFile<TTransaction>(
  context: ExportContext<TTransaction>,
  input: { sessionId: string; artifact: TurnArtifactRecord },
): Promise<void> {
  const { deps, zip, scrub, request } = context;
  if (input.artifact.digest === null) {
    return; // Skipped artifacts have an index row but no stored bytes.
  }
  const blob = await deps.turnArtifactStore.getBlob({
    tenant_id: request.subject.tenantId,
    digest: input.artifact.digest,
  });
  if (blob === undefined) {
    return;
  }
  // The writer normalizes and de-duplicates the name.
  const entryName = `files/${input.sessionId}/${input.artifact.path}`;
  // Text payloads pass both scrub layers; binary payloads ship byte-exact
  // (they are the caller's own uploaded files, behind include_uploads).
  let text: string | undefined;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(blob);
  } catch {
    text = undefined;
  }
  if (text !== undefined) {
    await zip.addTextEntry(entryName, scrub.text(text));
  } else {
    await zip.addBufferedEntry(entryName, blob);
  }
}

const MARKDOWN_MEMORY_FILES = [CURATED_MEMORY_FILE, VAULT_TOMBSTONES_FILE] as const;

async function writeMemoryEntries<TTransaction>(
  context: ExportContext<TTransaction>,
  personas: readonly Persona[],
): Promise<MemoryReport> {
  const { memorySource } = context.deps;
  const sharedIncluded = context.request.subject.includeInstanceData;
  if (memorySource.kind === 'unavailable') {
    return {
      backend: memorySource.backend,
      status: 'skipped',
      vaults: 0,
      shared_vaults_included: false,
      note: memorySource.reason,
    };
  }
  if (memorySource.kind === 'markdown') {
    const vaults = await writeMarkdownMemoryFiles(context, { markdownDir: memorySource.markdownDir, personas });
    return { backend: 'markdown', status: 'included', vaults, shared_vaults_included: sharedIncluded };
  }
  const vaults = await writeClientMemoryFiles(context, { client: memorySource.client, personas });
  return { backend: memorySource.backend, status: 'included', vaults, shared_vaults_included: sharedIncluded };
}

/**
 * Vault directories this user may take from the Markdown backend: their own persona vaults,
 * and, for instance data, the shared vault and the topic vaults (`<tenant>__<topic>`). Other
 * users' persona vaults are never listed. Topic vaults are found by prefix, the same scope the
 * vault API gives a tenant, so a tenant id that itself contains `__` would share that prefix.
 */
function markdownVaultDirs({
  tenantId,
  personas,
  includeInstanceData,
  dirNames,
}: {
  tenantId: string;
  personas: readonly Persona[];
  includeInstanceData: boolean;
  dirNames: readonly string[];
}): string[] {
  const shared = sanitizeNamespace(tenantId);
  const own = new Set(
    personas.map(persona =>
      sanitizeNamespace(
        vaultWriteNamespace({
          tenantNamespace: tenantId,
          scope: { personaName: persona.display_name, personaId: persona.id },
        }),
      ),
    ),
  );
  const wanted = dirNames.filter(name => {
    if (own.has(name)) {
      return true;
    }
    if (!includeInstanceData) {
      return false;
    }
    return (
      name === shared || (name.startsWith(`${shared}__`) && personaForVaultFilesystemNamespace(shared, name) === null)
    );
  });
  return wanted.sort();
}

/** Regular file text, or undefined when there is no such file. Links are never followed. */
async function regularFileText(filePath: string): Promise<string | undefined> {
  try {
    const info = await lstat(filePath);
    return info.isFile() ? await readFile(filePath, 'utf8') : undefined;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/** Verbatim Markdown-backend files: MEMORY.md, daily logs, tombstones. Derived caches and sharing config stay behind. */
async function writeMarkdownMemoryFiles<TTransaction>(
  context: ExportContext<TTransaction>,
  input: { markdownDir: string; personas: readonly Persona[] },
): Promise<number> {
  if (!existsSync(input.markdownDir)) {
    return 0;
  }
  const { subject } = context.request;
  const dirNames = markdownVaultDirs({
    tenantId: subject.tenantId,
    personas: input.personas,
    includeInstanceData: subject.includeInstanceData,
    dirNames: (await readdir(input.markdownDir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name),
  });
  for (const dirName of dirNames) {
    const dirPath = path.join(input.markdownDir, dirName);
    for (const fileName of MARKDOWN_MEMORY_FILES) {
      const text = await regularFileText(path.join(dirPath, fileName));
      if (text !== undefined) {
        await context.zip.addTextEntry(`memory/${dirName}/${fileName}`, context.scrub.text(text));
      }
    }
    const dailyDir = path.join(dirPath, 'memory');
    if (!existsSync(dailyDir)) {
      continue;
    }
    const dailyFiles = (await readdir(dailyDir, { withFileTypes: true }))
      .filter(entry => entry.isFile() && DAILY_LOG_FILE_PATTERN.test(entry.name))
      .map(entry => entry.name)
      .sort();
    for (const fileName of dailyFiles) {
      const text = await regularFileText(path.join(dailyDir, fileName));
      if (text !== undefined) {
        await context.zip.addTextEntry(`memory/${dirName}/memory/${fileName}`, context.scrub.text(text));
      }
    }
  }
  return dirNames.length;
}

/**
 * Non-Markdown backends render their vault entries into Markdown files in
 * the same layout the Markdown backend uses, one file per namespace named
 * for the export day, entries oldest first in the retain format
 * (`## <timestamp>` heading, then the text).
 */
async function writeClientMemoryFiles<TTransaction>(
  context: ExportContext<TTransaction>,
  input: { client: Pick<MemoryClient, 'listEntries'>; personas: readonly Persona[] },
): Promise<number> {
  const { subject, exportedAt } = context.request;
  const wireNamespaces: (string | undefined)[] = [
    ...(subject.includeInstanceData ? [undefined] : []),
    ...input.personas.map(persona => personaVaultNamespace(persona.display_name)),
  ];
  const fileDate = exportedAt.toISOString().slice(0, 10);
  let vaults = 0;
  for (const wireNamespace of wireNamespaces) {
    const outcome = await input.client.listEntries({
      namespace: wireNamespace ?? '',
      timeoutMs: MEMORY_LIST_TIMEOUT_MS,
    });
    if (!outcome.ok) {
      // Memory is part of the export; a namespace that cannot be read fails
      // the export rather than silently shipping without those memories.
      throw new Error(`Memory export failed for a namespace: ${outcome.reason}`);
    }
    if (outcome.entries.length === 0) {
      continue;
    }
    const fsNamespace = vaultFilesystemNamespace(subject.tenantId, wireNamespace);
    const rendered = [...outcome.entries]
      .reverse()
      .map(entry => `## ${entry.timestamp}\n\n${entry.text}`)
      .join('\n\n');
    await context.zip.addTextEntry(`memory/${fsNamespace}/memory/${fileDate}.md`, `${context.scrub.text(rendered)}\n`);
    vaults += 1;
  }
  return vaults;
}
