/**
 * Cross-store round trips: seed the rich fixture on one store backend, export,
 * import into an empty instance on the other backend for a new owner, export
 * again, and prove the two exports match apart from dates, the new owner, the
 * schedules-off rule, store-minted connector and knowledge-document ids, the
 * trust mark and permission settings import never carries over, and the turn that was running at export time landing cancelled.
 *
 * The Postgres side engages when PG_STORE_TESTS_ADMIN_URL is set (the local
 * test Postgres); without it the suite skips.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Transaction } from 'kysely';
import { createLogger } from 'winston';

import { McpCatalog } from '../../../src/catalog/McpCatalog';
import { sessionPartIndex } from '../../../src/dataExport/sessionRecords';
import { runDataImport, type DataImportDeps } from '../../../src/dataImport/importService';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { PostgresAgentStore } from '../../../src/db/postgres/agent-store/PostgresAgentStore';
import { PostgresGlobalSettingsStore } from '../../../src/db/postgres/global-settings-store/PostgresGlobalSettingsStore';
import { PostgresMcpServerStore } from '../../../src/db/postgres/mcp-server-store/PostgresMcpServerStore';
import { PostgresModelProviderStore } from '../../../src/db/postgres/model-provider-store/PostgresModelProviderStore';
import { PostgresPersonaStore } from '../../../src/db/postgres/persona-store/PostgresPersonaStore';
import { PostgresPersonalizationStore } from '../../../src/db/postgres/personalization-store/PostgresPersonalizationStore';
import { PostgresScheduleStore } from '../../../src/db/postgres/schedule-store/PostgresScheduleStore';
import { PostgresSentinelSettingsStore } from '../../../src/db/postgres/sentinel-settings-store/PostgresSentinelSettingsStore';
import { PostgresSessionStore } from '../../../src/db/postgres/session-store/PostgresSessionStore';
import { PostgresSpaceStore } from '../../../src/db/postgres/space-store/PostgresSpaceStore';
import { PostgresTurnArtifactStore } from '../../../src/db/postgres/turn-artifact-store/PostgresTurnArtifactStore';
import type { Database as PgDatabase } from '../../../src/db/postgres/types';
import { SentinelAuditStore } from '../../../src/db/sentinelAuditStore';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqlitePersonaStore } from '../../../src/db/sqlite/persona-store/SqlitePersonaStore';
import { SqlitePersonalizationStore } from '../../../src/db/sqlite/personalization-store/SqlitePersonalizationStore';
import { SqliteScheduleStore } from '../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { SqliteSentinelSettingsStore } from '../../../src/db/sqlite/sentinel-settings-store/SqliteSentinelSettingsStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { SqliteSpaceStore } from '../../../src/db/sqlite/space-store/SqliteSpaceStore';
import { SqliteTurnArtifactStore } from '../../../src/db/sqlite/turn-artifact-store/SqliteTurnArtifactStore';
import type { Database as SqliteDatabase } from '../../../src/db/sqlite/types';
import type { WithTransaction } from '../../../src/db/transaction';
import { PERSISTED_ARTIFACT_MIME } from '../../../src/runtime/artifacts/persistTurnArtifacts';
import { EMBEDDING_DIMENSIONS } from '../../../src/runtime/memory/embeddingModel';
import { createPostgresTestDatabase } from '../../db/postgres/testDatabase';
import { exportInstanceArchive } from '../../fixtures/dataTransferExport';
import { SEED_HISTORY, SEED_IDS, seedRichInstance, type DataTransferSeedStores } from '../../fixtures/dataTransferSeed';
import { isRecord, parseJson, recordAt, recordsAt, stringAt, type JsonRecord } from '../../fixtures/jsonGuards';
import { legacySessionsOf } from '../../fixtures/legacySessions';
import { readZipEntries } from '../../fixtures/zipReader';

const TENANT = 'default';

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
    auditStore: new SentinelAuditStore(db),
    turnArtifactStore: new SqliteTurnArtifactStore(db),
    mcpServerStore: new SqliteMcpServerStore(db),
    modelProviderStore: new SqliteModelProviderStore(db),
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
    auditStore: new SentinelAuditStore(db),
    turnArtifactStore: new PostgresTurnArtifactStore(db),
    mcpServerStore: new PostgresMcpServerStore(db),
    modelProviderStore: new PostgresModelProviderStore(db),
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

function exportArchive<Tx>(instance: Instance<Tx>, userId: string): Promise<Buffer> {
  return exportInstanceArchive({ instance, tenantId: TENANT, subjectId: userId });
}

async function importArchive<Tx>(instance: Instance<Tx>, archive: Buffer, userId: string): Promise<void> {
  const deps: DataImportDeps<Tx> = {
    sessionStore: instance.stores.sessionStore,
    personaStore: instance.stores.personaStore,
    personalizationStore: instance.stores.personalizationStore,
    spaceStore: instance.stores.spaceStore,
    scheduleStore: instance.stores.scheduleStore,
    globalSettingsStore: instance.stores.globalSettingsStore,
    auditStore: instance.stores.auditStore,
    turnArtifactStore: instance.stores.turnArtifactStore,
    mcpServerStore: instance.stores.mcpServerStore,
    modelProviderStore: instance.stores.modelProviderStore,
    agentStore: instance.stores.agentStore,
    mcpCatalog: McpCatalog.loadShipped(),
    withTransaction: instance.withTransaction,
    memoryTarget: { kind: 'markdown', markdownDir: instance.memoryDir },
    ownerName: '',
    personaKnowledgeDir: instance.knowledgeDir,
    knowledgeEmbedder: {
      ensureReady: () => Promise.resolve(true),
      embedPassages: texts => Promise.resolve(texts.map(() => new Array<number>(EMBEDDING_DIMENSIONS).fill(0.5))),
    },
    logger: createLogger({ silent: true }),
  };
  const result = await runDataImport(deps, {
    archive,
    subject: { tenantId: TENANT, subjectId: userId, subjectDisplayName: userId, agentIds: [] },
    maxBytes: 1024 * 1024 * 1024,
  });
  expect(result.chats).toBe(3);
  expect(result.agents).toBe(1);
  expect(result.schedules_off).toBe(true);
}

/** The chats come back with the dates and totals they had on the source, not the import time. */
async function expectChatHistoryRestored<Tx>(instance: Instance<Tx>): Promise<void> {
  for (const [sessionId, history] of Object.entries(SEED_HISTORY)) {
    const session = await instance.stores.sessionStore.getSession({ tenant_id: TENANT, session_id: sessionId });
    expect(session?.created_at.toISOString()).toBe(history.created_at);
    expect(session?.updated_at.toISOString()).toBe(history.updated_at);
    expect(session?.last_activity_timestamp_ms).toBe(history.last_activity_timestamp_ms);
    expect(session?.metrics).toEqual(history.metrics);
    for (const [turnId, dates] of Object.entries(history.turns)) {
      const turn = await instance.stores.sessionStore.getTurn({ session_id: sessionId, turn_id: turnId });
      expect(turn?.created_at.toISOString()).toBe(dates.created_at);
      expect(turn?.updated_at.toISOString()).toBe(dates.updated_at);
    }
  }
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

function normalizeValue(value: unknown, key: string | undefined): unknown {
  if (key !== undefined && DATE_KEYS.has(key) && (typeof value === 'string' || typeof value === 'number')) {
    return '<date>';
  }
  if (key === 'created_by' || key === 'updated_by' || key === 'subject_id' || key === 'subject_display_name') {
    return typeof value === 'string' ? '<owner>' : value;
  }
  if (Array.isArray(value)) {
    return value.map(item => normalizeValue(item, undefined));
  }
  if (isRecord(value)) {
    const out: JsonRecord = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = normalizeValue(childValue, childKey);
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
  if (name === 'sessions.json') {
    const entries = sortBy(recordsAt(normalized, name), entry =>
      stringAt(recordAt(entry['session'], 'session')['session_id'], 'session_id'),
    );
    for (const entry of entries) {
      const session = recordAt(entry['session'], 'session');
      // Import never carries Approve for this chat choices; expectNoApprovalGrants checks the target side.
      session['approval_grants'] = '<never imported>';
      entry['artifacts'] = sortBy(recordsAt(entry['artifacts'], 'artifacts'), artifact =>
        stringAt(artifact['path'], 'path'),
      );
      for (const artifact of recordsAt(entry['artifacts'], 'artifacts')) {
        // The imported side is checked by expectUploadsStoredAsDownloads; the source keeps the real type.
        artifact['mime'] = '<mime>';
      }
      if (session['session_id'] === SEED_IDS.sessionRunning) {
        // The turn that was running at export time lands cancelled on import:
        // its state changes and its stream gains the closing turn.done event.
        for (const turnEntry of recordsAt(entry['turns'], 'turns')) {
          recordAt(turnEntry['turn'], 'turn')['state'] = '<terminal-state>';
          turnEntry['events'] = recordsAt(turnEntry['events'], 'events').filter(event => event['type'] !== 'turn.done');
        }
      }
    }
    return entries;
  }
  if (name === 'schedules.json') {
    const schedules = sortBy(recordsAt(normalized, name), schedule => stringAt(schedule['id'], 'id'));
    for (const schedule of schedules) {
      schedule['status'] = '<status>';
      recordAt(schedule['manifest'], 'manifest')['status'] = '<status>';
    }
    return schedules;
  }
  if (name === 'personas.json') {
    const personas = sortBy(recordsAt(normalized, name), entry =>
      stringAt(recordAt(entry['persona'], 'persona')['id'], 'id'),
    );
    for (const entry of personas) {
      const knowledge = recordAt(entry['knowledge'], 'knowledge');
      const sorted = sortBy(recordsAt(knowledge['documents'], 'documents'), doc => stringAt(doc['title'], 'title'));
      for (const doc of sorted) {
        doc['id'] = '<doc-id>';
      }
      knowledge['documents'] = sorted;
    }
    return personas;
  }
  if (name === 'settings.json') {
    // Import never carries permission settings over, so only the instance settings can match.
    const instance = recordsAt(recordAt(normalized, name)['instance'], 'instance');
    return { instance: sortBy(instance, setting => stringAt(setting['key'], 'key')) };
  }
  if (name === 'connectors.json') {
    const connectors = sortBy(recordsAt(normalized, name), connector => stringAt(connector['name'], 'name'));
    for (const connector of connectors) {
      connector['id'] = '<connector-id>';
      // Import never carries the trust mark over, so the re-export always reads false.
      connector['first_party'] = false;
    }
    return connectors;
  }
  if (name === 'folders.json') {
    return sortBy(recordsAt(normalized, name), folder => stringAt(folder['folder_id'], 'folder_id'));
  }
  if (name === 'spaces.json') {
    return sortBy(recordsAt(normalized, name), entry => stringAt(recordAt(entry['space'], 'space')['id'], 'id'));
  }
  if (name === 'agents.json') {
    // Ids are kept on import, so they are compared as they are.
    return sortBy(recordsAt(normalized, name), agent => stringAt(agent['name'], 'name'));
  }
  if (name === 'manifest.json') {
    const manifest = recordAt(normalized, name);
    return {
      format: manifest['format'],
      schema_version: manifest['schema_version'],
      tenant_id: manifest['tenant_id'],
      include_uploads: manifest['include_uploads'],
    };
  }
  return normalized;
}

/** Audit rows get new ids on import; everything else, dates included, must come back as exported. */
function auditRowsWithoutIds(archive: Map<string, Buffer>): JsonRecord[] {
  return recordsAt(parseJson(archive.get('audit.json'), 'audit.json'), 'audit.json').map(row => {
    const { id: _id, ...rest } = row;
    return rest;
  });
}

function expectNoApprovalGrants(archive: Map<string, Buffer>): void {
  for (const entry of recordsAt(legacySessionsOf(archive), 'sessions')) {
    expect(recordAt(entry['session'], 'session')['approval_grants']).toEqual([]);
  }
}

/** Import stores every upload as a plain download, whatever type the archive claims. */
function expectUploadsStoredAsDownloads(archive: Map<string, Buffer>): void {
  for (const entry of recordsAt(legacySessionsOf(archive), 'sessions')) {
    for (const artifact of recordsAt(entry['artifacts'], 'artifacts')) {
      if (artifact['status'] === 'stored') {
        expect(artifact['mime']).toBe(PERSISTED_ARTIFACT_MIME);
      }
    }
  }
}

function expectExportsToMatch(first: Buffer, second: Buffer): void {
  const firstEntries = new Map(readZipEntries(first).map(entry => [entry.name, entry.data]));
  const secondEntries = new Map(readZipEntries(second).map(entry => [entry.name, entry.data]));
  expect([...secondEntries.keys()].sort()).toEqual([...firstEntries.keys()].sort());
  expect(auditRowsWithoutIds(secondEntries)).toEqual(auditRowsWithoutIds(firstEntries));
  expectNoApprovalGrants(secondEntries);
  expectUploadsStoredAsDownloads(secondEntries);
  expect(normalizeSection('sessions.json', legacySessionsOf(secondEntries))).toEqual(
    normalizeSection('sessions.json', legacySessionsOf(firstEntries)),
  );
  for (const [name, data] of firstEntries) {
    const other = secondEntries.get(name);
    expect(other).toBeDefined();
    if (name === 'audit.json' || sessionPartIndex(name) !== undefined) {
      continue;
    }
    if (name.endsWith('.json')) {
      expect(normalizeSection(name, parseJson(other, name))).toEqual(normalizeSection(name, parseJson(data, name)));
    } else {
      expect(other?.equals(data)).toBe(true);
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
      await expectChatHistoryRestored(target);
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
      await expectChatHistoryRestored(target);
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
