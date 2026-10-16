import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { AgentSpecSchema, InMemorySessionStore } from '@truefoundry/trueforge-core/agent-session';
import { makeCreateTurnInput, makeModelMessageEvent } from '../../../../trueforge-core/tests/agent-session/testHelpers';

import { runDataExport, type DataExportDeps, type MemoryExportSource } from '../../../src/dataExport/exportService';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
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
import { vaultFilesystemNamespace } from '../../../src/runtime/memory/markdownMemoryFiles';
import type { MemoryClient, MemoryVaultEntry } from '../../../src/runtime/memory/memoryClient';
import { McpServerManifestSchema } from '../../../src/schemas/mcpServer';
import { readZipEntries, zipEntryText } from '../../fixtures/zipReader';

const TENANT_ID = 'default';

class CollectingWritable extends Writable {
  readonly chunks: Buffer[] = [];
  bytes = 0;
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    callback();
  }
  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

async function makeDeps(
  memorySource: MemoryExportSource,
  overrides?: { sessionStore?: DataExportDeps<never>['sessionStore']; personaKnowledgeDir?: string },
): Promise<{ deps: DataExportDeps<never>; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'tfy-export-service-'));
  const db = createSqliteDb(join(dir, 'test.sqlite'));
  await migrateSqliteToLatest(db);
  const deps: DataExportDeps<never> = {
    sessionStore: overrides?.sessionStore ?? new SqliteSessionStore(db),
    personaStore: new SqlitePersonaStore(db),
    personalizationStore: new SqlitePersonalizationStore(db),
    spaceStore: new SqliteSpaceStore(db),
    scheduleStore: new SqliteScheduleStore(db),
    globalSettingsStore: new SqliteGlobalSettingsStore(db),
    sentinelSettingsStore: new SqliteSentinelSettingsStore(db),
    turnArtifactStore: new SqliteTurnArtifactStore(db),
    mcpServerStore: new SqliteMcpServerStore(db),
    memorySource,
    personaKnowledgeDir: overrides?.personaKnowledgeDir ?? join(dir, 'knowledge'),
  };
  return {
    deps,
    close: async () => {
      await db.destroy();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function exportRequest(includeUploads = false, maxBytes = 1024 * 1024 * 1024) {
  return {
    subject: { tenantId: TENANT_ID, subjectId: 'alice', agentIds: [], includeUploads },
    secrets: [],
    exportedAt: new Date('2026-10-16T12:00:00.000Z'),
    appVersion: '0.0.0-test',
    maxBytes,
  };
}

function vaultEntry(text: string, timestamp: string): MemoryVaultEntry {
  return { id: `id-${timestamp}`, text, timestamp, persona: null };
}

describe('runDataExport memory backends', () => {
  it('renders a client (hindsight) backend into Markdown files in the vault layout', async () => {
    const fakeClient = {
      listEntries: ({ namespace }: { namespace: string }) => {
        if (namespace === '') {
          return Promise.resolve({
            ok: true as const,
            entries: [
              vaultEntry('newest fact', '2026-10-02T10:00:00.000Z'),
              vaultEntry('oldest fact', '2026-10-01T10:00:00.000Z'),
            ],
          });
        }
        if (namespace === 'persona:Researcher') {
          return Promise.resolve({
            ok: true as const,
            entries: [vaultEntry('persona fact', '2026-10-03T10:00:00.000Z')],
          });
        }
        return Promise.resolve({ ok: true as const, entries: [] });
      },
    } as unknown as MemoryClient;

    const { deps, close } = await makeDeps({ kind: 'client', client: fakeClient });
    try {
      await deps.personaStore.createPersona({
        tenant_id: TENANT_ID,
        created_by: 'alice',
        id: 'persona-1',
        display_name: 'Researcher',
        updated_by: 'alice',
        aliases: [],
        instructions: 'Research.',
        model_name: 'test-provider/test-model',
      });
      const sink = new CollectingWritable();
      await runDataExport(deps, exportRequest(), sink);
      const entries = readZipEntries(sink.buffer());

      const shared = zipEntryText(entries, `memory/${TENANT_ID}/memory/2026-10-16.md`);
      expect(shared.indexOf('oldest fact')).toBeLessThan(shared.indexOf('newest fact'));
      expect(shared).toContain('## 2026-10-01T10:00:00.000Z');

      const personaNs = vaultFilesystemNamespace(TENANT_ID, 'persona:Researcher');
      const personaFile = zipEntryText(entries, `memory/${personaNs}/memory/2026-10-16.md`);
      expect(personaFile).toContain('persona fact');
    } finally {
      await close();
    }
  });

  it('fails the export when a client backend namespace cannot be read', async () => {
    const failingClient = {
      listEntries: () =>
        Promise.resolve({ ok: false as const, code: 'request_failed' as const, reason: 'backend down' }),
    } as unknown as MemoryClient;
    const { deps, close } = await makeDeps({ kind: 'client', client: failingClient });
    try {
      await expect(runDataExport(deps, exportRequest(), new CollectingWritable())).rejects.toThrow('backend down');
    } finally {
      await close();
    }
  });

  it('exports markdown vault files for the tenant only, including topic vaults', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'tfy-export-md-'));
    const memoryDir = join(scratch, 'memory');
    await mkdir(join(memoryDir, TENANT_ID, 'memory'), { recursive: true });
    await writeFile(join(memoryDir, TENANT_ID, 'MEMORY.md'), '# Shared\n');
    await mkdir(join(memoryDir, `${TENANT_ID}__trips`, 'memory'), { recursive: true });
    await writeFile(join(memoryDir, `${TENANT_ID}__trips`, 'MEMORY.md'), '# Trips\n');
    await writeFile(join(memoryDir, `${TENANT_ID}__trips`, 'memory', '2026-09-01.md'), 'trip note\n');
    await mkdir(join(memoryDir, 'other-tenant', 'memory'), { recursive: true });
    await writeFile(join(memoryDir, 'other-tenant', 'MEMORY.md'), '# Someone else\n');

    const { deps, close } = await makeDeps({ kind: 'markdown', markdownDir: memoryDir });
    try {
      const sink = new CollectingWritable();
      await runDataExport(deps, exportRequest(), sink);
      const names = readZipEntries(sink.buffer()).map(entry => entry.name);
      expect(names).toContain(`memory/${TENANT_ID}/MEMORY.md`);
      expect(names).toContain(`memory/${TENANT_ID}__trips/MEMORY.md`);
      expect(names).toContain(`memory/${TENANT_ID}__trips/memory/2026-09-01.md`);
      expect(names.some(name => name.includes('other-tenant'))).toBe(false);
    } finally {
      await close();
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe('runDataExport connector auth markers', () => {
  it('keeps only the dcr marker so an import can show the connector needs credentials', async () => {
    const { deps, close } = await makeDeps({ kind: 'markdown', markdownDir: join(tmpdir(), 'tfy-export-unused') });
    try {
      const seed = async (name: string, auth: Record<string, unknown>): Promise<void> => {
        await deps.mcpServerStore.createServer({
          tenant_id: TENANT_ID,
          name,
          first_party: false,
          manifest: McpServerManifestSchema.parse({
            type: 'remote',
            name,
            description: 'Test connector.',
            url: `https://${name}.example.com/mcp`,
            auth,
          }),
        });
      };
      await seed('dcr-one', { type: 'dcr' });
      await seed('header-one', { type: 'header', headers: { Authorization: 'Bearer sk-hidden' } });
      await seed('oauth-one', { type: 'oauth_client', client_id: 'client-1', client_secret: 'secret-1' });

      const sink = new CollectingWritable();
      await runDataExport(deps, exportRequest(), sink);
      const entries = readZipEntries(sink.buffer());
      const connectors = JSON.parse(zipEntryText(entries, 'connectors.json')) as {
        name: string;
        manifest: { auth?: unknown };
      }[];
      const byName = new Map(connectors.map(connector => [connector.name, connector.manifest]));
      expect(byName.get('dcr-one')?.auth).toEqual({ type: 'dcr' });
      expect(byName.get('header-one')).not.toHaveProperty('auth');
      expect(byName.get('oauth-one')).not.toHaveProperty('auth');
      expect(zipEntryText(entries, 'connectors.json')).not.toContain('sk-hidden');
      expect(zipEntryText(entries, 'connectors.json')).not.toContain('secret-1');
    } finally {
      await close();
    }
  });
});

describe('runDataExport on a large instance', () => {
  it('streams 2,000 sessions and 50,000 events with bounded memory', async () => {
    const SESSION_COUNT = 2_000;
    const EVENTS_PER_TURN = 25;
    const sessionStore = new InMemorySessionStore<SessionCustom, TurnCustom>();
    for (let i = 0; i < SESSION_COUNT; i += 1) {
      const sessionId = `bulk-session-${String(i)}`;
      await sessionStore.createSession({
        tenant_id: TENANT_ID,
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
      await sessionStore.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: `${sessionId}-turn-1`,
          new_context_appends: [
            {
              thread_id: 'main',
              context: [
                { role: 'user', content: `Question ${String(i)} about a fairly ordinary topic with some extra words.` },
                {
                  role: 'assistant',
                  content: `Answer ${String(i)} with a paragraph of explanation that takes some space.`,
                },
              ],
              current_context_usage: null,
            },
          ],
        }),
      );
      await sessionStore.appendToEvents({
        session_id: sessionId,
        turn_id: `${sessionId}-turn-1`,
        events: Array.from({ length: EVENTS_PER_TURN }, () => makeModelMessageEvent()),
      });
    }

    const { deps, close } = await makeDeps(
      { kind: 'markdown', markdownDir: join(tmpdir(), 'tfy-export-none') },
      { sessionStore },
    );
    try {
      const rssBefore = process.memoryUsage().rss;
      let peakRss = rssBefore;
      const startedAt = Date.now();
      const sink = new CollectingWritable();
      const baseWrite = sink._write.bind(sink);
      sink._write = (chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void) => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        baseWrite(chunk, encoding, callback);
      };
      const result = await runDataExport(deps, exportRequest(), sink);
      const elapsedMs = Date.now() - startedAt;
      const rssGrowthMb = (peakRss - rssBefore) / (1024 * 1024);
      // eslint-disable-next-line no-console
      console.log(
        `[data-export-large] sessions=${String(SESSION_COUNT)} events=${String(SESSION_COUNT * EVENTS_PER_TURN)} bytes=${String(result.bytesWritten)} elapsedMs=${String(elapsedMs)} maxRssGrowthMb=${rssGrowthMb.toFixed(1)}`,
      );
      expect(result.bytesWritten).toBe(sink.bytes);
      expect(rssGrowthMb).toBeLessThan(512);

      const entries = readZipEntries(sink.buffer());
      const sessions = JSON.parse(zipEntryText(entries, 'sessions.json')) as { turns: { events: unknown[] }[] }[];
      expect(sessions).toHaveLength(SESSION_COUNT);
      const totalEvents = sessions.reduce(
        (sum, session) => sum + session.turns.reduce((turnSum, turn) => turnSum + turn.events.length, 0),
        0,
      );
      expect(totalEvents).toBe(SESSION_COUNT * EVENTS_PER_TURN);
      const chats = JSON.parse(zipEntryText(entries, 'chats.json')) as unknown[];
      expect(chats).toHaveLength(SESSION_COUNT);
    } finally {
      await close();
    }
  }, 300_000);
});
