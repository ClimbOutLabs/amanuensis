/**
 * Streams one user's data export archive: one JSON file per section, the
 * memory tree as Markdown, and uploaded files only when requested. Never
 * exported: model providers and their keys, OAuth tokens, registered OAuth
 * clients, approval tokens, always-allow grants, the audit log, sandbox
 * state, and schedule run history.
 *
 * Every JSON value and every text file passes both secret layers before it
 * is written. Sections are produced item by item, so peak memory is bounded
 * by the largest single item, not by the size of the instance.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Writable } from 'node:stream';

import type {
  ISessionStore,
  SessionRecord,
  TokenPagination,
  TurnRecord,
} from '@truefoundry/trueforge-core/agent-session';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IMcpServerStore } from '../db/mcpServerStore';
import type { IPersonalizationStore } from '../db/personalizationStore';
import type { IPersonaStore } from '../db/personaStore';
import type { IScheduleStore } from '../db/scheduleStore';
import type { ISentinelSettingsStore } from '../db/sentinelSettingsStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import type { ISpaceStore } from '../db/spaceStore';
import type { ITurnArtifactStore, TurnArtifactRecord } from '../db/turnArtifactStore';
import { personaKnowledgeLocation } from '../personaKnowledge/knowledgePaths';
import { openPersonaKnowledgeRepository } from '../personaKnowledge/sqliteKnowledgeRepository';
import type { Persona } from '../personas/persona';
import { vaultFilesystemNamespace } from '../runtime/memory/markdownMemoryFiles';
import type { MemoryClient } from '../runtime/memory/memoryClient';
import { sessionToCommonChat } from './chatMapping';
import type { CommonChat } from './commonChatFormat';
import { scrubJsonForExport, scrubTextForExport } from './secretScrub';
import { ZipStreamWriter } from './zipStreamWriter';

export const EXPORT_FORMAT = 'aman-export';
export const EXPORT_SCHEMA_VERSION = 1;

const PAGE_LIMIT = 200;

/** Same bound the memory vault API uses for one list call. */
const MEMORY_LIST_TIMEOUT_MS = 10_000;

export interface ExportSubject {
  tenantId: string;
  subjectId: string;
  /** Agents the caller manages; their sessions and schedules are in scope alongside the caller's own. */
  agentIds: readonly string[];
  includeUploads: boolean;
}

/**
 * Where memory comes from: the Markdown backend is read from its files
 * verbatim; any other backend is read through its MemoryClient and rendered
 * into Markdown files in the same layout.
 */
export type MemoryExportSource = { kind: 'markdown'; markdownDir: string } | { kind: 'client'; client: MemoryClient };

export interface DataExportDeps<TTransaction> {
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  personaStore: IPersonaStore<TTransaction>;
  personalizationStore: IPersonalizationStore<TTransaction>;
  spaceStore: ISpaceStore<TTransaction>;
  scheduleStore: IScheduleStore<TTransaction>;
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  sentinelSettingsStore: ISentinelSettingsStore<TTransaction>;
  turnArtifactStore: ITurnArtifactStore<TTransaction>;
  mcpServerStore: IMcpServerStore<TTransaction>;
  memorySource: MemoryExportSource;
  /** Root dir of the per-persona knowledge SQLite files. */
  personaKnowledgeDir: string;
}

export interface DataExportRequest {
  subject: ExportSubject;
  /** Stored secret values for scrub layer 1 (see ./secretCollection). */
  secrets: readonly string[];
  exportedAt: Date;
  appVersion: string;
  maxBytes: number;
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
  return JSON.parse(JSON.stringify(value)) as unknown;
}

async function writeJsonArrayEntry(
  zip: ZipStreamWriter,
  name: string,
  items: Iterable<unknown> | AsyncIterable<unknown>,
  secrets: readonly string[],
): Promise<void> {
  await zip.addEntry(name, async sink => {
    await sink.writeText('[\n');
    let first = true;
    for await (const item of items) {
      const json = JSON.stringify(scrubJsonForExport(toPlainJson(item), secrets));
      await sink.writeText(first ? json : `,\n${json}`);
      first = false;
    }
    await sink.writeText(first ? ']' : '\n]');
  });
}

async function writeJsonEntry(
  zip: ZipStreamWriter,
  name: string,
  value: unknown,
  secrets: readonly string[],
): Promise<void> {
  await zip.addTextEntry(name, JSON.stringify(scrubJsonForExport(toPlainJson(value), secrets), null, 2));
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
): Promise<{ bytesWritten: number }> {
  const { subject, secrets } = request;
  const { tenantId, subjectId } = subject;
  const scope = { created_by_subject_id: subjectId, agent_ids: subject.agentIds };
  const zip = new ZipStreamWriter(out, { maxBytes: request.maxBytes });

  const folders = await deps.sessionStore.listSessionFolders({ tenant_id: tenantId, created_by: subjectId });
  const folderNameById = new Map(folders.map(folder => [folder.folder_id, folder.name]));
  const personas = await deps.personaStore.listPersonas({ tenant_id: tenantId, created_by: subjectId });

  const listSessionPage = () =>
    paged(pageToken =>
      deps.sessionStore.listSessions({
        tenant_id: tenantId,
        limit: PAGE_LIMIT,
        page_token: pageToken,
        order: 'asc',
        start_timestamp: undefined,
        end_timestamp: undefined,
        agent_id: undefined,
        created_by_or_agent_ids: scope,
        metadata: undefined,
        source_type: undefined,
        source_id: undefined,
      }),
    );

  function sessionStream(): AsyncGenerator<SessionRecord<SessionCustom>> {
    return listSessionPage();
  }

  // manifest.json
  await writeJsonEntry(
    zip,
    'manifest.json',
    {
      format: EXPORT_FORMAT,
      schema_version: EXPORT_SCHEMA_VERSION,
      exported_at: request.exportedAt.toISOString(),
      app_version: request.appVersion,
      include_uploads: subject.includeUploads,
    },
    secrets,
  );

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
  await writeJsonArrayEntry(zip, 'chats.json', chats(), secrets);

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
        const eventList: unknown[] = [];
        for await (const event of events) {
          eventList.push(event);
        }
        turnsWithEvents.push({ turn, events: eventList });
        artifacts.push(
          ...(await deps.turnArtifactStore.listArtifacts({
            tenant_id: tenantId,
            session_id: session.session_id,
            turn_id: turn.turn_id,
          })),
        );
      }
      yield { session, turns: turnsWithEvents, artifacts };
      if (subject.includeUploads) {
        uploadedBlobs.push(...artifacts.map(artifact => ({ sessionId: session.session_id, artifact })));
      }
    }
  }
  await writeJsonArrayEntry(zip, 'sessions.json', sessions(), secrets);

  // folders.json
  await writeJsonArrayEntry(zip, 'folders.json', folders, secrets);

  // personas.json: personas with their knowledge documents and chunk text.
  function* personaEntries(): Iterable<unknown> {
    for (const persona of personas) {
      yield { persona, knowledge: readPersonaKnowledge(deps, tenantId, persona) };
    }
  }
  await writeJsonArrayEntry(zip, 'personas.json', personaEntries(), secrets);

  // personalization.json
  const profile = await deps.personalizationStore.getProfile({ tenant_id: tenantId, created_by: subjectId });
  await writeJsonEntry(zip, 'personalization.json', profile ?? null, secrets);

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
  await writeJsonArrayEntry(zip, 'spaces.json', spaceEntries(), secrets);

  // schedules.json: definitions only, never run history.
  const schedules = paged(pageToken =>
    deps.scheduleStore.listSchedules({
      tenant_id: tenantId,
      limit: PAGE_LIMIT,
      page_token: pageToken,
      agent_names: undefined,
      created_by_or_agent_ids: scope,
    }),
  );
  await writeJsonArrayEntry(zip, 'schedules.json', schedules, secrets);

  // connectors.json: connector entries with no auth fields at all.
  async function* connectorEntries(): AsyncIterable<unknown> {
    const servers = await deps.mcpServerStore.listServers({ tenant_id: tenantId, names: undefined });
    for (const server of servers) {
      const manifest = { ...server.manifest };
      delete manifest.auth;
      yield {
        id: server.id,
        name: server.name,
        first_party: server.first_party,
        created_at: server.created_at,
        updated_at: server.updated_at,
        manifest,
      };
    }
  }
  await writeJsonArrayEntry(zip, 'connectors.json', connectorEntries(), secrets);

  // settings.json: global settings plus the caller's permission settings.
  const globalSettings = await deps.globalSettingsStore.listSettings();
  const permissionSettings = await deps.sentinelSettingsStore.get({ tenant_id: tenantId, created_by: subjectId });
  await writeJsonEntry(
    zip,
    'settings.json',
    {
      global: globalSettings.map(setting => ({ key: setting.key, value: setting.value })),
      permission_settings: permissionSettings,
    },
    secrets,
  );

  // memory/: Markdown files as stored (markdown backend) or rendered (client backends).
  await writeMemoryEntries(zip, deps, { tenantId, personas, exportedAt: request.exportedAt }, secrets);

  // files/: uploaded file bytes, only when requested.
  if (subject.includeUploads) {
    for (const { sessionId, artifact } of uploadedBlobs) {
      await writeUploadedFile(zip, deps, { tenantId, sessionId, artifact }, secrets);
    }
  }

  await zip.finish();
  return { bytesWritten: zip.bytesWritten };
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

function sanitizeZipPath(rawPath: string): string {
  const segments = rawPath.split('/').filter(segment => segment.length > 0 && segment !== '.' && segment !== '..');
  return segments.length > 0 ? segments.join('/') : 'file';
}

async function writeUploadedFile<TTransaction>(
  zip: ZipStreamWriter,
  deps: DataExportDeps<TTransaction>,
  input: { tenantId: string; sessionId: string; artifact: TurnArtifactRecord },
  secrets: readonly string[],
): Promise<void> {
  if (input.artifact.digest === null) {
    return; // Skipped artifacts have an index row but no stored bytes.
  }
  const blob = await deps.turnArtifactStore.getBlob({ tenant_id: input.tenantId, digest: input.artifact.digest });
  if (blob === undefined) {
    return;
  }
  const entryName = `files/${sanitizeZipPath(input.sessionId)}/${sanitizeZipPath(input.artifact.path)}`;
  // Text payloads pass both scrub layers; binary payloads ship byte-exact
  // (they are the caller's own uploaded files, behind include_uploads).
  let text: string | undefined;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(blob);
  } catch {
    text = undefined;
  }
  if (text !== undefined) {
    await zip.addTextEntry(entryName, scrubTextForExport(text, secrets));
  } else {
    await zip.addBufferedEntry(entryName, blob);
  }
}

const MARKDOWN_MEMORY_FILES = ['MEMORY.md', '.vault-tombstones.md', '.vault-sharing.json'] as const;

async function writeMemoryEntries<TTransaction>(
  zip: ZipStreamWriter,
  deps: DataExportDeps<TTransaction>,
  input: { tenantId: string; personas: Persona[]; exportedAt: Date },
  secrets: readonly string[],
): Promise<void> {
  if (deps.memorySource.kind === 'markdown') {
    await writeMarkdownMemoryFiles(
      zip,
      { markdownDir: deps.memorySource.markdownDir, tenantId: input.tenantId },
      secrets,
    );
    return;
  }
  await writeClientMemoryFiles(zip, deps.memorySource.client, input, secrets);
}

/** Verbatim Markdown-backend files: MEMORY.md, daily logs, tombstones, sharing config. Derived caches stay behind. */
async function writeMarkdownMemoryFiles(
  zip: ZipStreamWriter,
  input: { markdownDir: string; tenantId: string },
  secrets: readonly string[],
): Promise<void> {
  if (!existsSync(input.markdownDir)) {
    return;
  }
  const tenantSegment = vaultFilesystemNamespace(input.tenantId, undefined);
  const dirNames = (await readdir(input.markdownDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => name === tenantSegment || name.startsWith(`${tenantSegment}__`))
    .sort();
  for (const dirName of dirNames) {
    const dirPath = path.join(input.markdownDir, dirName);
    for (const fileName of MARKDOWN_MEMORY_FILES) {
      const filePath = path.join(dirPath, fileName);
      if (existsSync(filePath)) {
        await writeScrubbedTextFile(zip, { entryName: `memory/${dirName}/${fileName}`, filePath }, secrets);
      }
    }
    const dailyDir = path.join(dirPath, 'memory');
    if (existsSync(dailyDir)) {
      const dailyFiles = (await readdir(dailyDir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
        .map(entry => entry.name)
        .sort();
      for (const fileName of dailyFiles) {
        await writeScrubbedTextFile(
          zip,
          { entryName: `memory/${dirName}/memory/${fileName}`, filePath: path.join(dailyDir, fileName) },
          secrets,
        );
      }
    }
  }
}

async function writeScrubbedTextFile(
  zip: ZipStreamWriter,
  input: { entryName: string; filePath: string },
  secrets: readonly string[],
): Promise<void> {
  const text = await readFile(input.filePath, 'utf8');
  await zip.addTextEntry(input.entryName, scrubTextForExport(text, secrets));
}

/**
 * Non-Markdown backends render their vault entries into Markdown files in
 * the same layout the Markdown backend uses, one file per namespace named
 * for the export day, entries oldest first in the retain format
 * (`## <timestamp>` heading, then the text).
 */
async function writeClientMemoryFiles(
  zip: ZipStreamWriter,
  client: MemoryClient,
  input: { tenantId: string; personas: Persona[]; exportedAt: Date },
  secrets: readonly string[],
): Promise<void> {
  const wireNamespaces: (string | undefined)[] = [
    undefined,
    ...input.personas.map(persona => `persona:${persona.display_name}`),
  ];
  const fileDate = input.exportedAt.toISOString().slice(0, 10);
  for (const wireNamespace of wireNamespaces) {
    const outcome = await client.listEntries({ namespace: wireNamespace ?? '', timeoutMs: MEMORY_LIST_TIMEOUT_MS });
    if (!outcome.ok) {
      // Memory is part of the export; a namespace that cannot be read fails
      // the export rather than silently shipping without those memories.
      throw new Error(`Memory export failed for a namespace: ${outcome.reason}`);
    }
    if (outcome.entries.length === 0) {
      continue;
    }
    const fsNamespace = vaultFilesystemNamespace(input.tenantId, wireNamespace);
    const rendered = [...outcome.entries]
      .reverse()
      .map(entry => `## ${entry.timestamp}\n\n${entry.text}`)
      .join('\n\n');
    await zip.addTextEntry(`memory/${fsNamespace}/memory/${fileDate}.md`, `${scrubTextForExport(rendered, secrets)}\n`);
  }
}
