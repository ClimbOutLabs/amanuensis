/**
 * Cross-store round trips: seed the rich fixture on one store backend, export,
 * import into an empty instance on the other backend for a new owner, export
 * again, and prove the two exports match apart from dates, the new owner, the
 * schedules-off rule, store-minted connector and knowledge-document ids, and
 * the turn that was running at export time landing cancelled.
 *
 * The Postgres side engages when PG_STORE_TESTS_ADMIN_URL is set (the local
 * test Postgres); without it the suite skips.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import type { Transaction } from 'kysely';

import { runDataExport, type DataExportDeps } from '../../../src/dataExport/exportService';
import { runDataImport, type DataImportDeps } from '../../../src/dataImport/importService';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { PostgresAgentStore } from '../../../src/db/postgres/agent-store/PostgresAgentStore';
import { PostgresGlobalSettingsStore } from '../../../src/db/postgres/global-settings-store/PostgresGlobalSettingsStore';
import { PostgresMcpServerStore } from '../../../src/db/postgres/mcp-server-store/PostgresMcpServerStore';
import { PostgresPersonaStore } from '../../../src/db/postgres/persona-store/PostgresPersonaStore';
import { PostgresPersonalizationStore } from '../../../src/db/postgres/personalization-store/PostgresPersonalizationStore';
import { PostgresScheduleStore } from '../../../src/db/postgres/schedule-store/PostgresScheduleStore';
import { PostgresSentinelSettingsStore } from '../../../src/db/postgres/sentinel-settings-store/PostgresSentinelSettingsStore';
import { PostgresSessionStore } from '../../../src/db/postgres/session-store/PostgresSessionStore';
import { PostgresSpaceStore } from '../../../src/db/postgres/space-store/PostgresSpaceStore';
import { PostgresTurnArtifactStore } from '../../../src/db/postgres/turn-artifact-store/PostgresTurnArtifactStore';
import type { Database as PgDatabase } from '../../../src/db/postgres/types';
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
import type { Database as SqliteDatabase } from '../../../src/db/sqlite/types';
import type { WithTransaction } from '../../../src/db/transaction';
import { EMBEDDING_DIMENSIONS } from '../../../src/runtime/memory/embeddingModel';
import { createPostgresTestDatabase } from '../../db/postgres/testDatabase';
import { SEED_IDS, seedRichInstance, type DataTransferSeedStores } from '../../fixtures/dataTransferSeed';
import { readZipEntries } from '../../fixtures/zipReader';

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

type SqliteTx = Transaction<SqliteDatabase>;
type PgTx = Transaction<PgDatabase>;

interface Instance<Tx> {
  stores: DataTransferSeedStores<Tx>;
  withTransaction: WithTransaction<Tx>;
  memoryDir: string;
  knowledgeDir: string;
  close: () => Promise<void>;
}

async function makeSqliteInstance(label: string): Promise<Instance<SqliteTx>> {
  const dir = await mkdtemp(join(tmpdir(), `tfy-roundtrip-${label}-`));
  const db = createSqliteDb(join(dir, 'test.sqlite'));
  await migrateSqliteToLatest(db);
  const stores: DataTransferSeedStores<SqliteTx> = {
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
  const withTransaction: WithTransaction<SqliteTx> = callback => db.transaction().execute(callback);
  return {
    stores,
    withTransaction,
    memoryDir: join(dir, 'memory'),
    knowledgeDir: join(dir, 'knowledge'),
    close: async () => {
      await db.destroy();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function makePostgresInstance(label: string): Promise<Instance<PgTx> | undefined> {
  const pg = await createPostgresTestDatabase();
  if (pg === undefined) {
    return undefined;
  }
  const dir = await mkdtemp(join(tmpdir(), `tfy-roundtrip-${label}-`));
  const db = pg.db;
  const stores: DataTransferSeedStores<PgTx> = {
    sessionStore: new PostgresSessionStore(db),
    agentStore: new PostgresAgentStore(db),
    personaStore: new PostgresPersonaStore(db),
    personalizationStore: new PostgresPersonalizationStore(db),
    spaceStore: new PostgresSpaceStore(db),
    scheduleStore: new PostgresScheduleStore(db),
    globalSettingsStore: new PostgresGlobalSettingsStore(db),
    sentinelSettingsStore: new PostgresSentinelSettingsStore(db),
    turnArtifactStore: new PostgresTurnArtifactStore(db),
    mcpServerStore: new PostgresMcpServerStore(db),
  };
  const withTransaction: WithTransaction<PgTx> = callback => db.transaction().execute(callback);
  return {
    stores,
    withTransaction,
    memoryDir: join(dir, 'memory'),
    knowledgeDir: join(dir, 'knowledge'),
    close: async () => {
      await pg.teardown();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function exportArchive<Tx>(instance: Instance<Tx>, userId: string): Promise<Buffer> {
  const deps: DataExportDeps<Tx> = {
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
  const sink = new CollectingWritable();
  await runDataExport(
    deps,
    {
      subject: { tenantId: TENANT, subjectId: userId, agentIds: [], includeUploads: true },
      secrets: [],
      exportedAt: new Date('2026-10-16T12:00:00.000Z'),
      appVersion: '0.0.0-test',
      maxBytes: 1024 * 1024 * 1024,
    },
    sink,
  );
  return sink.buffer();
}

async function importArchive<Tx>(instance: Instance<Tx>, archive: Buffer, userId: string): Promise<void> {
  const deps: DataImportDeps<Tx> = {
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
    withTransaction: instance.withTransaction,
    memoryTarget: { kind: 'markdown', markdownDir: instance.memoryDir },
    personaKnowledgeDir: instance.knowledgeDir,
    embedKnowledgeChunks: (texts: string[]) => Promise.resolve(texts.map(() => new Float32Array(EMBEDDING_DIMENSIONS))),
  };
  const result = await runDataImport(deps, {
    archive,
    subject: { tenantId: TENANT, subjectId: userId, subjectDisplayName: userId, agentIds: [] },
    maxBytes: 1024 * 1024 * 1024,
  });
  expect(result.chats).toBe(3);
  expect(result.schedules_off).toBe(true);
}

// --- Export comparison with the allowed differences normalized away. ---

const DATE_KEYS = new Set([
  'created_at',
  'updated_at',
  'exported_at',
  'completed_at',
  'last_activity_timestamp_ms',
  'scheduled_for',
  // The common chat format's per-message timestamp, derived from turn times.
  'time',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeValue(value: unknown, key: string | undefined): unknown {
  if (key !== undefined && DATE_KEYS.has(key) && (typeof value === 'string' || typeof value === 'number')) {
    return '<date>';
  }
  if (key === 'total_duration_ms') {
    // Folded by the store from its own turn timeline; restarts on import.
    return '<duration>';
  }
  if (key === 'created_by' || key === 'updated_by' || key === 'subject_id' || key === 'subject_display_name') {
    return typeof value === 'string' ? '<owner>' : value;
  }
  if (key === 'agent_id') {
    return '<agent>';
  }
  if (Array.isArray(value)) {
    return value.map(item => normalizeValue(item, undefined));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = normalizeValue(childValue, childKey);
    }
    if (out['type'] === 'reference' && typeof out['id'] === 'string' && 'name' in out) {
      out['id'] = '<agent>';
    }
    return out;
  }
  return value;
}

function sortBy<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => key(a).localeCompare(key(b)));
}

function normalizeSection(name: string, parsed: unknown): unknown {
  const normalized = normalizeValue(parsed, undefined);
  if (name === 'sessions.json' && Array.isArray(normalized)) {
    const entries = sortBy(normalized as Record<string, unknown>[], entry =>
      String((entry['session'] as Record<string, unknown>)['session_id']),
    );
    for (const entry of entries) {
      const session = entry['session'] as Record<string, unknown>;
      const artifacts = entry['artifacts'];
      if (Array.isArray(artifacts)) {
        entry['artifacts'] = sortBy(artifacts as Record<string, unknown>[], artifact => String(artifact['path']));
      }
      if (session['session_id'] === SEED_IDS.sessionRunning) {
        // The turn that was running at export time lands cancelled on import:
        // its state changes and its stream gains the closing turn.done event.
        const turns = entry['turns'] as Record<string, unknown>[];
        for (const turnEntry of turns) {
          const turn = turnEntry['turn'] as Record<string, unknown>;
          turn['state'] = '<terminal-state>';
          const events = turnEntry['events'] as Record<string, unknown>[];
          turnEntry['events'] = events.filter(event => event['type'] !== 'turn.done');
        }
      }
    }
    return entries;
  }
  if (name === 'schedules.json' && Array.isArray(normalized)) {
    const schedules = sortBy(normalized as Record<string, unknown>[], schedule => String(schedule['id']));
    for (const schedule of schedules) {
      schedule['status'] = '<status>';
      const manifest = schedule['manifest'] as Record<string, unknown>;
      manifest['status'] = '<status>';
    }
    return schedules;
  }
  if (name === 'personas.json' && Array.isArray(normalized)) {
    const personas = sortBy(normalized as Record<string, unknown>[], entry =>
      String((entry['persona'] as Record<string, unknown>)['id']),
    );
    for (const entry of personas) {
      const knowledge = entry['knowledge'] as Record<string, unknown>;
      const documents = knowledge['documents'] as Record<string, unknown>[];
      const sorted = sortBy(documents, doc => String(doc['title']));
      for (const doc of sorted) {
        doc['id'] = '<doc-id>';
      }
      knowledge['documents'] = sorted;
    }
    return personas;
  }
  if (name === 'connectors.json' && Array.isArray(normalized)) {
    const connectors = sortBy(normalized as Record<string, unknown>[], connector => String(connector['name']));
    for (const connector of connectors) {
      connector['id'] = '<connector-id>';
    }
    return connectors;
  }
  if (name === 'folders.json' && Array.isArray(normalized)) {
    return sortBy(normalized as Record<string, unknown>[], folder => String(folder['folder_id']));
  }
  if (name === 'spaces.json' && Array.isArray(normalized)) {
    return sortBy(normalized as Record<string, unknown>[], entry =>
      String((entry['space'] as Record<string, unknown>)['id']),
    );
  }
  if (name === 'settings.json' && isRecord(normalized)) {
    const global = normalized['global'] as Record<string, unknown>[];
    normalized['global'] = sortBy(global, setting => String(setting['key']));
    return normalized;
  }
  if (name === 'manifest.json' && isRecord(normalized)) {
    return {
      format: normalized['format'],
      schema_version: normalized['schema_version'],
      include_uploads: normalized['include_uploads'],
    };
  }
  if (name === 'chats.json' && isRecord(normalized)) {
    const chats = normalized['chats'] as Record<string, unknown>[];
    normalized['chats'] = sortBy(chats, chat => String(chat['id']));
    return normalized;
  }
  return normalized;
}

function expectExportsToMatch(first: Buffer, second: Buffer): void {
  const firstEntries = new Map(readZipEntries(first).map(entry => [entry.name, entry.data]));
  const secondEntries = new Map(readZipEntries(second).map(entry => [entry.name, entry.data]));
  expect([...secondEntries.keys()].sort()).toEqual([...firstEntries.keys()].sort());
  for (const [name, data] of firstEntries) {
    const other = secondEntries.get(name);
    expect(other).toBeDefined();
    if (name.endsWith('.json')) {
      const a = normalizeSection(name, JSON.parse(data.toString('utf8')) as unknown);
      const b = normalizeSection(name, JSON.parse((other as Buffer).toString('utf8')) as unknown);
      expect(b).toEqual(a);
    } else {
      expect((other as Buffer).equals(data)).toBe(true);
    }
  }
}

const describePg = process.env['PG_STORE_TESTS_ADMIN_URL'] ? describe : describe.skip;

jest.setTimeout(240_000);

describePg('data export/import cross-store round trips', () => {
  it('SQLite to Postgres: the re-export matches apart from dates and the new owner', async () => {
    const source = await makeSqliteInstance('sqlite-source');
    const target = await makePostgresInstance('pg-target');
    if (target === undefined) {
      throw new Error('Postgres test database unavailable despite PG_STORE_TESTS_ADMIN_URL being set.');
    }
    try {
      await seedRichInstance({
        stores: source.stores,
        tenantId: TENANT,
        userId: 'alice',
        memoryDir: source.memoryDir,
        knowledgeDir: source.knowledgeDir,
      });
      const first = await exportArchive(source, 'alice');
      await importArchive(target, first, 'bob');
      // Imported schedules are off on the Postgres side too.
      const schedules = await target.stores.scheduleStore.listSchedules({
        tenant_id: TENANT,
        limit: 10,
        page_token: undefined,
        agent_names: undefined,
        created_by_or_agent_ids: { created_by_subject_id: 'bob', agent_ids: [] },
      });
      expect(schedules.data).toHaveLength(2);
      expect(schedules.data.every(schedule => schedule.status === 'paused')).toBe(true);
      const second = await exportArchive(target, 'bob');
      expectExportsToMatch(first, second);
    } finally {
      await source.close();
      await target.close();
    }
  }, 180_000);

  it('Postgres to SQLite: the re-export matches apart from dates and the new owner', async () => {
    const source = await makePostgresInstance('pg-source');
    if (source === undefined) {
      throw new Error('Postgres test database unavailable despite PG_STORE_TESTS_ADMIN_URL being set.');
    }
    const target = await makeSqliteInstance('sqlite-target');
    try {
      await seedRichInstance({
        stores: source.stores,
        tenantId: TENANT,
        userId: 'alice',
        memoryDir: source.memoryDir,
        knowledgeDir: source.knowledgeDir,
      });
      const first = await exportArchive(source, 'alice');
      await importArchive(target, first, 'bob');
      const schedules = await target.stores.scheduleStore.listSchedules({
        tenant_id: TENANT,
        limit: 10,
        page_token: undefined,
        agent_names: undefined,
        created_by_or_agent_ids: { created_by_subject_id: 'bob', agent_ids: [] },
      });
      expect(schedules.data).toHaveLength(2);
      expect(schedules.data.every(schedule => schedule.status === 'paused')).toBe(true);
      const second = await exportArchive(target, 'bob');
      expectExportsToMatch(first, second);
    } finally {
      await source.close();
      await target.close();
    }
  }, 180_000);
});
