import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { AgentSpecSchema, InMemorySessionStore } from '@truefoundry/trueforge-core/agent-session';
import { sql, type Transaction } from 'kysely';
import { makeCreateTurnInput, makeModelMessageEvent } from '../../../../trueforge-core/tests/agent-session/testHelpers';

import { runDataExport, type DataExportDeps } from '../../../src/dataExport/exportService';
import { ZipStreamWriter } from '../../../src/dataExport/zipStreamWriter';
import {
  DataImportError,
  runDataImport,
  type DataImportDeps,
  type MemoryImportTarget,
} from '../../../src/dataImport/importService';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqlitePersonaStore } from '../../../src/db/sqlite/persona-store/SqlitePersonaStore';
import { SqlitePersonalizationStore } from '../../../src/db/sqlite/personalization-store/SqlitePersonalizationStore';
import { SqliteScheduleStore } from '../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { SqliteSentinelSettingsStore } from '../../../src/db/sqlite/sentinel-settings-store/SqliteSentinelSettingsStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { SqliteSpaceStore } from '../../../src/db/sqlite/space-store/SqliteSpaceStore';
import { SqliteTurnArtifactStore } from '../../../src/db/sqlite/turn-artifact-store/SqliteTurnArtifactStore';
import type { Database } from '../../../src/db/sqlite/types';
import { personaKnowledgeLocation } from '../../../src/personaKnowledge/knowledgePaths';
import { openPersonaKnowledgeRepository } from '../../../src/personaKnowledge/sqliteKnowledgeRepository';
import { EMBEDDING_DIMENSIONS } from '../../../src/runtime/memory/embeddingModel';
import type { MemoryClient } from '../../../src/runtime/memory/memoryClient';
import { McpServerManifestSchema, resolveMcpAuthStatus } from '../../../src/schemas/mcpServer';
import { SEED_IDS, SEED_MEMORY, seedRichInstance, type DataTransferSeedStores } from '../../fixtures/dataTransferSeed';
import { readZipEntries } from '../../fixtures/zipReader';

jest.setTimeout(120_000);

const TENANT = 'default';

class CollectingWritable extends Writable {
  private readonly chunks: Buffer[] = [];
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

type Tx = Transaction<Database>;

interface Instance {
  dir: string;
  stores: DataTransferSeedStores<Tx>;
  db: ReturnType<typeof createSqliteDb>;
  memoryDir: string;
  knowledgeDir: string;
  embeddedTexts: string[];
  close: () => Promise<void>;
}

async function makeInstance(label: string): Promise<Instance> {
  const dir = await mkdtemp(join(tmpdir(), `tfy-import-${label}-`));
  const db = createSqliteDb(join(dir, 'test.sqlite'));
  await migrateSqliteToLatest(db);
  const stores: DataTransferSeedStores<Tx> = {
    sessionStore: new SqliteSessionStore(db),
    agentStore: new SqliteAgentStore(db),
    personaStore: new SqlitePersonaStore(db),
    personalizationStore: new SqlitePersonalizationStore(db),
    spaceStore: new SqliteSpaceStore(db),
    scheduleStore: new SqliteScheduleStore(db),
    globalSettingsStore: new SqliteGlobalSettingsStore(db),
    sentinelSettingsStore: new SqliteSentinelSettingsStore(db),
    turnArtifactStore: new SqliteTurnArtifactStore(db),
    mcpServerStore: new SqliteMcpServerStore(db),
  };
  return {
    dir,
    stores,
    db,
    memoryDir: join(dir, 'memory'),
    knowledgeDir: join(dir, 'knowledge'),
    embeddedTexts: [],
    close: async () => {
      await db.destroy();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function exportDeps(instance: Instance): DataExportDeps<Tx> {
  return {
    sessionStore: instance.stores.sessionStore,
    personaStore: instance.stores.personaStore,
    personalizationStore: instance.stores.personalizationStore,
    spaceStore: instance.stores.spaceStore,
    scheduleStore: instance.stores.scheduleStore,
    globalSettingsStore: instance.stores.globalSettingsStore,
    sentinelSettingsStore: instance.stores.sentinelSettingsStore,
    turnArtifactStore: instance.stores.turnArtifactStore,
    mcpServerStore: instance.stores.mcpServerStore,
    memorySource: { kind: 'markdown', markdownDir: instance.memoryDir },
    personaKnowledgeDir: instance.knowledgeDir,
  };
}

function importDeps(instance: Instance, memoryTarget?: MemoryImportTarget): DataImportDeps<Tx> {
  return {
    sessionStore: instance.stores.sessionStore,
    personaStore: instance.stores.personaStore,
    personalizationStore: instance.stores.personalizationStore,
    spaceStore: instance.stores.spaceStore,
    scheduleStore: instance.stores.scheduleStore,
    globalSettingsStore: instance.stores.globalSettingsStore,
    sentinelSettingsStore: instance.stores.sentinelSettingsStore,
    turnArtifactStore: instance.stores.turnArtifactStore,
    mcpServerStore: instance.stores.mcpServerStore,
    agentStore: instance.stores.agentStore,
    withTransaction: callback => instance.db.transaction().execute(callback),
    memoryTarget: memoryTarget ?? { kind: 'markdown', markdownDir: instance.memoryDir },
    personaKnowledgeDir: instance.knowledgeDir,
    embedKnowledgeChunks: (texts: string[]) => {
      instance.embeddedTexts.push(...texts);
      return Promise.resolve(texts.map(() => new Float32Array(EMBEDDING_DIMENSIONS)));
    },
  };
}

async function exportArchive(instance: Instance, includeUploads = true): Promise<Buffer> {
  const sink = new CollectingWritable();
  await runDataExport(
    exportDeps(instance),
    {
      subject: { tenantId: TENANT, subjectId: 'alice', agentIds: [], includeUploads },
      secrets: [],
      exportedAt: new Date('2026-10-16T12:00:00.000Z'),
      appVersion: '0.0.0-test',
      maxBytes: 1024 * 1024 * 1024,
    },
    sink,
  );
  return sink.buffer();
}

function importRequest(archive: Buffer, userId = 'bob', maxBytes = 1024 * 1024 * 1024) {
  return {
    archive,
    subject: { tenantId: TENANT, subjectId: userId, subjectDisplayName: userId, agentIds: [] as string[] },
    maxBytes,
  };
}

/** Rebuilds an archive with one mutation applied to its entries. */
async function repack(archive: Buffer, mutate: (entries: Map<string, Buffer>) => void): Promise<Buffer> {
  const entries = new Map(readZipEntries(archive).map(entry => [entry.name, entry.data]));
  mutate(entries);
  const sink = new CollectingWritable();
  const writer = new ZipStreamWriter(sink, { maxBytes: 1024 * 1024 * 1024 });
  for (const [name, data] of entries) {
    await writer.addEntry(name, async entrySink => {
      await entrySink.write(data);
    });
  }
  await writer.finish();
  return sink.buffer();
}

/** Seeds the source instance and returns its export archive. */
async function seededArchive(includeUploads = true): Promise<{ source: Instance; archive: Buffer }> {
  const source = await makeInstance('source');
  await seedRichInstance({
    stores: source.stores,
    tenantId: TENANT,
    userId: 'alice',
    memoryDir: source.memoryDir,
    knowledgeDir: source.knowledgeDir,
  });
  const archive = await exportArchive(source, includeUploads);
  return { source, archive };
}

describe('runDataImport', () => {
  it('imports a full export into an empty instance for a new owner', async () => {
    const { source, archive } = await seededArchive();
    const target = await makeInstance('target');
    try {
      const result = await runDataImport(importDeps(target), importRequest(archive));
      expect(result.chats).toBe(3);
      expect(result.memories).toBe(3);
      expect(result.personas).toBe(2);
      expect(result.spaces).toBe(1);
      expect(result.schedules).toBe(2);
      expect(result.folders).toBe(1);
      expect(result.connectors).toBe(3);
      expect(result.connectors_skipped).toBe(0);
      expect(result.schedules_off).toBe(true);
      expect(result.summary).toBe(
        'Imported 3 chats, 3 memories, 2 personas, 1 space, 2 schedules (off). ' +
          'Not imported: model keys, connector sign-ins, Always allow choices. Set those up in Settings.',
      );

      const sessions = await target.stores.sessionStore.listSessions({
        tenant_id: TENANT,
        limit: 10,
        page_token: undefined,
        order: 'asc',
        start_timestamp: undefined,
        end_timestamp: undefined,
        agent_id: undefined,
        created_by_or_agent_ids: { created_by_subject_id: 'bob', agent_ids: [] },
        metadata: undefined,
        source_type: undefined,
        source_id: undefined,
      });
      expect(sessions.data.map(session => session.session_id).sort()).toEqual([
        SEED_IDS.sessionMain,
        SEED_IDS.sessionScheduled,
        SEED_IDS.sessionRunning,
      ]);
      const main = sessions.data.find(session => session.session_id === SEED_IDS.sessionMain);
      expect(main?.created_by_subject.subject_id).toBe('bob');
      expect(main?.folder_id).toBe(SEED_IDS.folder);
      expect(main?.title).toBe('First chat');
      expect(main?.approval_grants).toContain('reporter-server:search');

      const lastTurn = await target.stores.sessionStore.getTurn({
        session_id: SEED_IDS.sessionMain,
        turn_id: 'session-1-turn-3',
      });
      const mainThread = lastTurn?.snapshot.threads['main'];
      expect(mainThread?.context).toEqual([
        { role: 'user', content: 'Summary: capitals of France and Spain.' },
        { role: 'assistant', content: 'Understood.' },
      ]);

      const checklist = await target.stores.sessionStore.getTaskChecklist({
        tenant_id: TENANT,
        session_id: SEED_IDS.sessionMain,
      });
      expect(checklist.items).toEqual([
        { id: 'item-1', text: 'Book flights', done: true },
        { id: 'item-2', text: 'Reserve hotel', done: false },
      ]);

      // The schedule-born chat now points at a placeholder agent owned by bob.
      const placeholder = await target.stores.agentStore.getAgent({ tenant_id: TENANT, name: SEED_IDS.agentName });
      expect(placeholder?.created_by_subject.subject_id).toBe('bob');
      const scheduled = sessions.data.find(session => session.session_id === SEED_IDS.sessionScheduled);
      expect(scheduled?.agent).toEqual({ type: 'reference', id: placeholder?.id, name: SEED_IDS.agentName });
      expect(scheduled?.source).toEqual({ type: 'schedule', id: SEED_IDS.scheduleDaily, run_id: 'run-1' });

      // The turn that was running at export time lands cancelled as abandoned.
      const running = await target.stores.sessionStore.getTurn({
        session_id: SEED_IDS.sessionRunning,
        turn_id: 'session-3-turn-1',
      });
      expect(running?.state).toMatchObject({ status: 'cancelled', reason: 'abandoned' });

      // Schedules keep their ids, belong to bob, and are off with no run queued.
      const daily = await target.stores.scheduleStore.getSchedule({ tenant_id: TENANT, id: SEED_IDS.scheduleDaily });
      expect(daily?.id).toBe(SEED_IDS.scheduleDaily);
      expect(daily?.status).toBe('paused');
      expect(daily?.manifest.status).toBe('paused');
      expect(daily?.created_by_subject.subject_id).toBe('bob');
      expect(daily?.agent_id).toBe(placeholder?.id);
      const pendingRun = await target.stores.scheduleStore.getScheduledRunFor({
        tenant_id: TENANT,
        schedule_id: SEED_IDS.scheduleDaily,
      });
      expect(pendingRun).toBeUndefined();

      // Connectors: the dcr one reads "needs credentials"; the header one's secret never lands.
      const servers = await target.stores.mcpServerStore.listServers({ tenant_id: TENANT, names: undefined });
      expect(servers.map(server => server.name).sort()).toEqual([
        'dcr-connector',
        'header-connector',
        'plain-connector',
      ]);
      const dcr = servers.find(server => server.name === 'dcr-connector');
      expect(dcr?.manifest.auth).toEqual({ type: 'dcr' });
      expect(dcr !== undefined && resolveMcpAuthStatus({ manifest: dcr.manifest }).status).toBe('auth_required');
      const header = servers.find(server => server.name === 'header-connector');
      expect(header?.manifest.auth).toBeUndefined();
      expect(JSON.stringify(servers)).not.toContain('sk-secret-header-value');

      // Personas keep their ids and owner.
      const personas = await target.stores.personaStore.listPersonas({ tenant_id: TENANT, created_by: 'bob' });
      expect(personas.map(persona => persona.id).sort()).toEqual([SEED_IDS.personaChef, SEED_IDS.personaResearcher]);

      // Knowledge was re-indexed: the embedder saw the chunk texts and the documents are ready.
      expect(target.embeddedTexts.sort()).toEqual([
        'First chunk of field notes.',
        'Only chunk of the reference page.',
        'Second chunk of field notes.',
      ]);
      const repo = openPersonaKnowledgeRepository({
        dbPath: personaKnowledgeLocation({
          knowledgeDir: target.knowledgeDir,
          tenantId: TENANT,
          personaId: SEED_IDS.personaResearcher,
        }).dbPath,
      });
      try {
        const documents = repo.listDocuments();
        expect(documents.map(doc => doc.title).sort()).toEqual(['Field notes', 'Reference page']);
        expect(documents.every(doc => doc.status === 'ready')).toBe(true);
        const chunks = documents.flatMap(doc =>
          repo.listDocumentChunks({ documentId: doc.id }).map(chunk => chunk.text),
        );
        expect(chunks.sort()).toEqual([
          'First chunk of field notes.',
          'Only chunk of the reference page.',
          'Second chunk of field notes.',
        ]);
      } finally {
        repo.close();
      }

      const profile = await target.stores.personalizationStore.getProfile({ tenant_id: TENANT, created_by: 'bob' });
      expect(profile?.assistant_name).toBe('Aman');
      expect(profile?.pinned_preferences).toEqual(['Answer concisely.']);

      const spaces = await target.stores.spaceStore.listSpaces({
        tenant_id: TENANT,
        created_by: 'bob',
        status: undefined,
        limit: 10,
        offset: 0,
      });
      expect(spaces).toHaveLength(1);
      expect(spaces[0]?.id).toBe(SEED_IDS.space);
      expect(spaces[0]?.body).toBe('Draft two.');
      expect(spaces[0]?.revision).toBe(2);
      const revision1 = await target.stores.spaceStore.getSpaceRevision({
        tenant_id: TENANT,
        created_by: 'bob',
        space_id: SEED_IDS.space,
        revision: 1,
      });
      const revision2 = await target.stores.spaceStore.getSpaceRevision({
        tenant_id: TENANT,
        created_by: 'bob',
        space_id: SEED_IDS.space,
        revision: 2,
      });
      expect([revision1?.body, revision2?.body]).toEqual(['Draft one.', 'Draft two.']);

      expect((await target.stores.globalSettingsStore.getSetting({ key: 'ui.theme' }))?.value).toBe('denim');
      const sentinel = await target.stores.sentinelSettingsStore.get({ tenant_id: TENANT, created_by: 'bob' });
      expect(sentinel.offline_mode).toBe(true);
      expect(sentinel.tier2_auto_allow).toEqual(['file_write']);
      expect(sentinel.search_without_asking).toBe(true);

      // Memory files land verbatim, tombstone file included.
      const curated = await readFile(join(target.memoryDir, TENANT, 'MEMORY.md'), 'utf8');
      expect(curated).toBe(`${SEED_MEMORY.curated}\n`);
      const dailyFile = await readFile(join(target.memoryDir, TENANT, 'memory', '2026-10-01.md'), 'utf8');
      expect(dailyFile).toContain(SEED_MEMORY.keptEntryText);
      const tombstones = await readFile(join(target.memoryDir, TENANT, '.vault-tombstones.md'), 'utf8');
      expect(tombstones).toContain(`md:${TENANT}:2026-10-01.md#1`);
      const personaMemory = await readFile(
        join(target.memoryDir, `${TENANT}__persona_Researcher`, 'memory', '2026-10-02.md'),
        'utf8',
      );
      expect(personaMemory).toContain(SEED_MEMORY.personaEntryText);

      // The stored artifact kept its index data and its bytes.
      const artifacts = await target.stores.turnArtifactStore.listArtifacts({
        tenant_id: TENANT,
        session_id: SEED_IDS.sessionMain,
        turn_id: 'session-1-turn-1',
      });
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toMatchObject({ path: 'notes.txt', name: 'notes.txt', status: 'stored' });
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('refuses a second import once the instance has data', async () => {
    const { source, archive } = await seededArchive();
    const target = await makeInstance('target-second');
    try {
      await runDataImport(importDeps(target), importRequest(archive));
      const error: unknown = await runDataImport(importDeps(target), importRequest(archive)).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(DataImportError);
      expect(error).toMatchObject({ status: 409 });
      expect(error instanceof Error && error.message).toContain('already has data');
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('refuses an export made by a newer version', async () => {
    const { source, archive } = await seededArchive();
    const target = await makeInstance('target-newer');
    try {
      const newer = await repack(archive, entries => {
        const manifest = JSON.parse(entries.get('manifest.json')?.toString('utf8') ?? '{}') as Record<string, unknown>;
        manifest['schema_version'] = 2;
        entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
      });
      const error: unknown = await runDataImport(importDeps(target), importRequest(newer)).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(DataImportError);
      expect(error).toMatchObject({ status: 400 });
      expect(error instanceof Error && error.message).toContain('newer version of Aman');
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('refuses a file that is not an export', async () => {
    const target = await makeInstance('target-foreign');
    try {
      const error: unknown = await runDataImport(importDeps(target), importRequest(Buffer.from('hello'))).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(DataImportError);
      expect(error).toMatchObject({ status: 400 });
    } finally {
      await target.close();
    }
  });

  it('refuses an archive with a missing section', async () => {
    const { source, archive } = await seededArchive();
    const target = await makeInstance('target-missing');
    try {
      const broken = await repack(archive, entries => {
        entries.delete('sessions.json');
      });
      const error: unknown = await runDataImport(importDeps(target), importRequest(broken)).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(DataImportError);
      expect(error instanceof Error && error.message).toContain('missing its sessions.json section');
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('refuses an archive with a damaged section', async () => {
    const { source, archive } = await seededArchive();
    const target = await makeInstance('target-damaged');
    try {
      const broken = await repack(archive, entries => {
        entries.set('personas.json', Buffer.from('{not json'));
      });
      const error: unknown = await runDataImport(importDeps(target), importRequest(broken)).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(DataImportError);
      expect(error).toMatchObject({ status: 400 });
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('refuses an archive whose turns point at another session', async () => {
    const { source, archive } = await seededArchive();
    const target = await makeInstance('target-crossref');
    try {
      const broken = await repack(archive, entries => {
        const sessions = JSON.parse(entries.get('sessions.json')?.toString('utf8') ?? '[]') as {
          turns: { turn: { session_id: string } }[];
        }[];
        const first = sessions[0];
        if (first !== undefined && first.turns[0] !== undefined) {
          first.turns[0].turn.session_id = 'some-other-session';
        }
        entries.set('sessions.json', Buffer.from(JSON.stringify(sessions)));
      });
      const error: unknown = await runDataImport(importDeps(target), importRequest(broken)).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(DataImportError);
      expect(error).toMatchObject({ status: 400 });
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('refuses an archive over the byte cap', async () => {
    const { source, archive } = await seededArchive();
    const target = await makeInstance('target-cap');
    try {
      const error: unknown = await runDataImport(importDeps(target), importRequest(archive, 'bob', 128)).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(DataImportError);
      expect(error instanceof Error && error.message).toContain('larger than the import limit');
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('keeps an existing connector and counts it skipped', async () => {
    const { source, archive } = await seededArchive();
    const target = await makeInstance('target-connector');
    try {
      await target.stores.mcpServerStore.createServer({
        tenant_id: TENANT,
        name: 'plain-connector',
        first_party: false,
        manifest: McpServerManifestSchema.parse({
          type: 'remote',
          name: 'plain-connector',
          description: 'Already here.',
          url: 'https://existing.example.com/mcp',
        }),
      });
      const result = await runDataImport(importDeps(target), importRequest(archive));
      expect(result.connectors).toBe(2);
      expect(result.connectors_skipped).toBe(1);
      const servers = await target.stores.mcpServerStore.listServers({ tenant_id: TENANT, names: undefined });
      const kept = servers.find(server => server.name === 'plain-connector');
      expect(kept?.manifest).toMatchObject({ url: 'https://existing.example.com/mcp' });
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('imports artifacts as skipped when the files were not included in the export', async () => {
    const { source, archive } = await seededArchive(false);
    const target = await makeInstance('target-artifacts');
    try {
      await runDataImport(importDeps(target), importRequest(archive));
      const artifacts = await target.stores.turnArtifactStore.listArtifacts({
        tenant_id: TENANT,
        session_id: SEED_IDS.sessionMain,
        turn_id: 'session-1-turn-1',
      });
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toMatchObject({ path: 'notes.txt', status: 'skipped_missing' });
    } finally {
      await source.close();
      await target.close();
    }
  });
});

describe('runDataImport failure handling', () => {
  it('rolls back the database transaction and compensates earlier writes when a late write fails', async () => {
    const { source, archive } = await seededArchive();
    const target = await makeInstance('target-txfail');
    try {
      await sql`CREATE TRIGGER import_fail_space_update BEFORE UPDATE ON space BEGIN SELECT RAISE(ABORT, 'injected failure'); END`.execute(
        target.db,
      );
      const error: unknown = await runDataImport(importDeps(target), importRequest(archive)).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(DataImportError);
      expect(error).toMatchObject({ status: 500 });

      // The transaction rolled back: no personas, spaces, schedules, or settings.
      expect(await target.stores.personaStore.listPersonas({ tenant_id: TENANT, created_by: 'bob' })).toHaveLength(0);
      expect(
        await target.stores.spaceStore.listSpaces({
          tenant_id: TENANT,
          created_by: 'bob',
          status: undefined,
          limit: 10,
          offset: 0,
        }),
      ).toHaveLength(0);
      // Compensation removed the earlier writes: sessions, folders, agents, knowledge, memory.
      const sessions = await target.stores.sessionStore.listSessions({
        tenant_id: TENANT,
        limit: 1,
        page_token: undefined,
        order: 'asc',
        start_timestamp: undefined,
        end_timestamp: undefined,
        agent_id: undefined,
        created_by_or_agent_ids: { created_by_subject_id: 'bob', agent_ids: [] },
        metadata: undefined,
        source_type: undefined,
        source_id: undefined,
      });
      expect(sessions.data).toHaveLength(0);
      expect(
        await target.stores.sessionStore.getSessionFolder({
          tenant_id: TENANT,
          folder_id: SEED_IDS.folder,
          created_by: 'bob',
        }),
      ).toBeUndefined();
      expect(await target.stores.agentStore.getAgent({ tenant_id: TENANT, name: SEED_IDS.agentName })).toBeUndefined();
      expect(
        existsSync(
          personaKnowledgeLocation({
            knowledgeDir: target.knowledgeDir,
            tenantId: TENANT,
            personaId: SEED_IDS.personaResearcher,
          }).dbPath,
        ),
      ).toBe(false);
      expect(existsSync(join(target.memoryDir, TENANT, 'MEMORY.md'))).toBe(false);

      // With the fault gone, the same archive imports cleanly into the same instance.
      await sql`DROP TRIGGER import_fail_space_update`.execute(target.db);
      const result = await runDataImport(importDeps(target), importRequest(archive));
      expect(result.chats).toBe(3);
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('compensates when the memory write fails partway', async () => {
    const { source, archive } = await seededArchive();
    const target = await makeInstance('target-memfail');
    try {
      await mkdir(target.memoryDir, { recursive: true });
      // A regular file where the tenant vault directory must go: the memory
      // write fails after sessions and knowledge have already been written.
      await writeFile(join(target.memoryDir, TENANT), 'blocker', 'utf8');
      const error: unknown = await runDataImport(importDeps(target), importRequest(archive)).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(DataImportError);
      const sessions = await target.stores.sessionStore.listSessions({
        tenant_id: TENANT,
        limit: 1,
        page_token: undefined,
        order: 'asc',
        start_timestamp: undefined,
        end_timestamp: undefined,
        agent_id: undefined,
        created_by_or_agent_ids: { created_by_subject_id: 'bob', agent_ids: [] },
        metadata: undefined,
        source_type: undefined,
        source_id: undefined,
      });
      expect(sessions.data).toHaveLength(0);
      expect(await target.stores.agentStore.getAgent({ tenant_id: TENANT, name: SEED_IDS.agentName })).toBeUndefined();

      await rm(join(target.memoryDir, TENANT));
      const result = await runDataImport(importDeps(target), importRequest(archive));
      expect(result.chats).toBe(3);
      expect(result.memories).toBe(3);
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('imports memory into a client backend, applying tombstones', async () => {
    const { source, archive } = await seededArchive();
    const target = await makeInstance('target-client-memory');
    try {
      const retained: { content: string; context?: string }[] = [];
      const fakeClient = {
        listEntries: () => Promise.resolve({ ok: true as const, entries: [] }),
        retain: ({ items }: { items: { content: string; context?: string }[] }) => {
          retained.push(...items);
          return Promise.resolve({ ok: true as const });
        },
      } as unknown as MemoryClient;
      const result = await runDataImport(
        importDeps(target, { kind: 'client', client: fakeClient }),
        importRequest(archive),
      );
      expect(result.memories).toBe(3);
      expect(retained).toHaveLength(3);
      const contents = retained.map(item => item.content);
      expect(contents).toContain(SEED_MEMORY.curated);
      expect(contents).toContain(SEED_MEMORY.keptEntryText);
      expect(contents).toContain(SEED_MEMORY.personaEntryText);
      expect(contents.join('\n')).not.toContain('train book project');
      const personaItem = retained.find(item => item.content === SEED_MEMORY.personaEntryText);
      expect(personaItem?.context).toBe('persona:Researcher');
    } finally {
      await source.close();
      await target.close();
    }
  });
});

describe('runDataImport at scale', () => {
  it('imports a 2,000 chat, 50,000 event archive within a bounded memory growth', async () => {
    const source = await makeInstance('source-large');
    const target = await makeInstance('target-large');
    try {
      const inMemory = new InMemorySessionStore<SessionCustom, TurnCustom>();
      const sessionCount = 2000;
      const eventsPerSession = 25;
      for (let index = 0; index < sessionCount; index += 1) {
        const sessionId = `bulk-session-${String(index)}`;
        const turnId = `${sessionId}-turn-1`;
        await inMemory.createSession({
          tenant_id: TENANT,
          session_id: sessionId,
          created_by_subject: { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' },
          agent: {
            type: 'inline',
            spec: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
          },
          custom: null,
          metadata: {},
          external_id: null,
          source: null,
        });
        await inMemory.createTurn(
          makeCreateTurnInput({
            sessionId,
            turnId,
            update_session_title_if_not_exist: `Bulk chat ${String(index)}`,
            new_context_appends: [
              {
                thread_id: 'main',
                context: [{ role: 'user', content: `Question ${String(index)}` }],
                current_context_usage: null,
              },
            ],
          }),
        );
        const events = Array.from({ length: eventsPerSession }, () => makeModelMessageEvent());
        await inMemory.appendToEvents({ session_id: sessionId, turn_id: turnId, events });
        const state = {
          status: 'done' as const,
          output: null,
          required_actions: [],
          completed_at: new Date().toISOString(),
        };
        await inMemory.updateTurnState({
          session_id: sessionId,
          turn_id: turnId,
          state,
          turn_done_event: {
            type: 'turn.done',
            id: `done-${turnId}`,
            created_at: state.completed_at,
            state,
            thread_id: null,
          },
        });
      }
      const sink = new CollectingWritable();
      await runDataExport(
        { ...exportDeps(source), sessionStore: inMemory },
        {
          subject: { tenantId: TENANT, subjectId: 'alice', agentIds: [], includeUploads: false },
          secrets: [],
          exportedAt: new Date('2026-10-16T12:00:00.000Z'),
          appVersion: '0.0.0-test',
          maxBytes: 1024 * 1024 * 1024,
        },
        sink,
      );
      const archive = sink.buffer();

      const rssBefore = process.memoryUsage().rss;
      const startedAt = Date.now();
      const result = await runDataImport(importDeps(target), importRequest(archive));
      const elapsedMs = Date.now() - startedAt;
      const rssGrowthMb = (process.memoryUsage().rss - rssBefore) / (1024 * 1024);
      console.log(`large import: ${String(elapsedMs)}ms, RSS growth ${rssGrowthMb.toFixed(1)}MB`);
      expect(result.chats).toBe(sessionCount);
      expect(rssGrowthMb).toBeLessThan(512);
      const sample = await target.stores.sessionStore.getSession({
        tenant_id: TENANT,
        session_id: 'bulk-session-1999',
      });
      expect(sample?.title).toBe('Bulk chat 1999');
    } finally {
      await source.close();
      await target.close();
    }
  }, 300_000);
});
