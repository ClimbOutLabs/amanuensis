import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { AgentSpecSchema, InMemorySessionStore } from '@truefoundry/trueforge-core/agent-session';
import { z } from 'zod';
import { makeCreateTurnInput, makeModelMessageEvent } from '../../../../trueforge-core/tests/agent-session/testHelpers';

import {
  AFTER_IMPORT_NOTICE,
  runDataExport,
  type DataExportDeps,
  type MemoryExportSource,
} from '../../../src/dataExport/exportService';
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
import { personaVaultNamespace, vaultFilesystemNamespace } from '../../../src/runtime/memory/markdownMemoryFiles';
import type { MemoryClient, MemoryVaultEntry } from '../../../src/runtime/memory/memoryClient';
import { readZipEntries, zipEntryJson, zipEntryText } from '../../fixtures/zipReader';

const TENANT_ID = 'default';

const ManifestSchema = z.object({
  tenant_id: z.string(),
  redactions: z.number(),
  memory: z.object({ backend: z.string(), status: z.string(), vaults: z.number(), note: z.string().optional() }),
});

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
    listAgents: () => Promise.resolve([]),
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

function exportRequest(options?: { includeUploads?: boolean; includeInstanceData?: boolean; tenantId?: string }) {
  const maxBytes = 1024 * 1024 * 1024;
  return {
    subject: {
      tenantId: options?.tenantId ?? TENANT_ID,
      subjectId: 'alice',
      includeUploads: options?.includeUploads ?? false,
      includeInstanceData: options?.includeInstanceData ?? true,
    },
    secrets: [],
    exportedAt: new Date('2026-10-16T12:00:00.000Z'),
    appVersion: '0.0.0-test',
    maxBytes,
  };
}

function vaultEntry(text: string, timestamp: string): MemoryVaultEntry {
  return { id: `id-${timestamp}`, text, timestamp, persona: null };
}

function listing(entriesByNamespace: Record<string, MemoryVaultEntry[]>): {
  client: Pick<MemoryClient, 'listEntries'>;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    client: {
      listEntries: ({ namespace }) => {
        asked.push(namespace);
        return Promise.resolve({ ok: true as const, entries: entriesByNamespace[namespace] ?? [] });
      },
    },
  };
}

async function createPersona(deps: DataExportDeps<never>, input: { id: string; name: string; owner: string }) {
  await deps.personaStore.createPersona({
    tenant_id: TENANT_ID,
    created_by: input.owner,
    id: input.id,
    display_name: input.name,
    updated_by: input.owner,
    aliases: [],
    instructions: 'Research.',
    model_name: 'test-provider/test-model',
  });
}

describe('runDataExport after-import notice', () => {
  it('tells the person what to redo, in the manifest and in README.txt', async () => {
    const { deps, close } = await makeDeps({ kind: 'client', backend: 'hindsight', client: listing({}).client });
    try {
      const sink = new CollectingWritable();
      await runDataExport(deps, exportRequest(), sink);
      const entries = readZipEntries(sink.buffer());
      const notice =
        'Model keys and connector sign-ins are not included. After you import, enter your model keys again and sign in to each connector again.';
      expect(AFTER_IMPORT_NOTICE).toBe(notice);
      expect(zipEntryText(entries, 'README.txt')).toBe(`${notice}\n`);
      expect(zipEntryJson(entries, 'manifest.json')).toMatchObject({ after_import: notice });
    } finally {
      await close();
    }
  });
});

describe('runDataExport memory backends', () => {
  it('renders a client (hindsight) backend into Markdown files in the vault layout', async () => {
    const { client } = listing({
      '': [
        vaultEntry('newest fact', '2026-10-02T10:00:00.000Z'),
        vaultEntry('oldest fact', '2026-10-01T10:00:00.000Z'),
      ],
      'persona:Researcher': [vaultEntry('persona fact', '2026-10-03T10:00:00.000Z')],
    });
    const { deps, close } = await makeDeps({ kind: 'client', backend: 'hindsight', client });
    try {
      await createPersona(deps, { id: 'persona-1', name: 'Researcher', owner: 'alice' });
      const sink = new CollectingWritable();
      await runDataExport(deps, exportRequest(), sink);
      const entries = readZipEntries(sink.buffer());

      const shared = zipEntryText(entries, `memory/${TENANT_ID}/memory/2026-10-16.md`);
      expect(shared.indexOf('oldest fact')).toBeLessThan(shared.indexOf('newest fact'));
      expect(shared).toContain('## 2026-10-01T10:00:00.000Z');

      const personaNs = vaultFilesystemNamespace(TENANT_ID, 'persona:Researcher');
      expect(zipEntryText(entries, `memory/${personaNs}/memory/2026-10-16.md`)).toContain('persona fact');
      expect(ManifestSchema.parse(zipEntryJson(entries, 'manifest.json')).memory).toMatchObject({
        backend: 'hindsight',
        status: 'included',
        vaults: 2,
      });
    } finally {
      await close();
    }
  });

  it("reads only the caller's own persona vaults unless instance data is included", async () => {
    const { client, asked } = listing({ '': [vaultEntry('shared fact', '2026-10-02T10:00:00.000Z')] });
    const { deps, close } = await makeDeps({ kind: 'client', backend: 'hindsight', client });
    try {
      await createPersona(deps, { id: 'persona-1', name: 'Researcher', owner: 'alice' });
      await createPersona(deps, { id: 'persona-2', name: 'Other', owner: 'bob' });
      const sink = new CollectingWritable();
      await runDataExport(deps, exportRequest({ includeInstanceData: false }), sink);
      expect(asked).toEqual(['persona:Researcher']);
      expect(readZipEntries(sink.buffer()).some(entry => entry.name.startsWith('memory/'))).toBe(false);
    } finally {
      await close();
    }
  });

  it('fails the export when a client backend namespace cannot be read', async () => {
    const failing: Pick<MemoryClient, 'listEntries'> = {
      listEntries: () =>
        Promise.resolve({ ok: false as const, code: 'request_failed' as const, reason: 'backend down' }),
    };
    const { deps, close } = await makeDeps({ kind: 'client', backend: 'hindsight', client: failing });
    try {
      await expect(runDataExport(deps, exportRequest(), new CollectingWritable())).rejects.toThrow('backend down');
    } finally {
      await close();
    }
  });

  it('skips memory with a manifest note when the backend is not set up', async () => {
    const { deps, close } = await makeDeps({
      kind: 'unavailable',
      backend: 'hindsight',
      reason: 'No memory provider is set up on this instance, so memory was not exported.',
    });
    try {
      const sink = new CollectingWritable();
      await runDataExport(deps, exportRequest(), sink);
      const entries = readZipEntries(sink.buffer());
      expect(ManifestSchema.parse(zipEntryJson(entries, 'manifest.json')).memory).toMatchObject({
        backend: 'hindsight',
        status: 'skipped',
        vaults: 0,
        note: 'No memory provider is set up on this instance, so memory was not exported.',
      });
      expect(entries.some(entry => entry.name.startsWith('memory/'))).toBe(false);
    } finally {
      await close();
    }
  });

  describe('markdown vaults', () => {
    let scratch: string;
    let memoryDir: string;

    beforeEach(async () => {
      scratch = await mkdtemp(join(tmpdir(), 'tfy-export-md-'));
      memoryDir = join(scratch, 'memory');
    });

    afterEach(async () => {
      await rm(scratch, { recursive: true, force: true });
    });

    async function vault(dir: string, files: Record<string, string>): Promise<void> {
      await mkdir(join(memoryDir, dir, 'memory'), { recursive: true });
      for (const [name, text] of Object.entries(files)) {
        await writeFile(join(memoryDir, dir, name), text);
      }
    }

    async function exportedNames(options: { tenantId?: string; includeInstanceData?: boolean; owned?: string[] }) {
      const { deps, close } = await makeDeps({ kind: 'markdown', markdownDir: memoryDir });
      try {
        for (const [index, name] of (options.owned ?? []).entries()) {
          await createPersona(deps, { id: `persona-${String(index)}`, name, owner: 'alice' });
        }
        const sink = new CollectingWritable();
        await runDataExport(deps, exportRequest(options), sink);
        return readZipEntries(sink.buffer()).map(entry => entry.name);
      } finally {
        await close();
      }
    }

    it('takes the shared vault and topic vaults for instance data, never other personas or tenants', async () => {
      const mine = vaultFilesystemNamespace(TENANT_ID, personaVaultNamespace('Researcher'));
      const theirs = vaultFilesystemNamespace(TENANT_ID, personaVaultNamespace('Bob Persona'));
      await vault(TENANT_ID, { 'MEMORY.md': '# Shared\n', '.vault-sharing.json': '{}', '.embeddings.json': '{}' });
      await vault(mine, { 'MEMORY.md': '# Mine\n' });
      await vault(theirs, { 'MEMORY.md': '# Theirs\n' });
      await vault(`${TENANT_ID}__trips`, { 'MEMORY.md': '# Trips\n' });
      await writeFile(join(memoryDir, `${TENANT_ID}__trips`, 'memory', '2026-09-01.md'), 'trip note\n');
      await vault('other-tenant', { 'MEMORY.md': '# Someone else\n' });
      await vault(`${TENANT_ID}x`, { 'MEMORY.md': '# Lookalike\n' });

      const names = await exportedNames({ owned: ['Researcher'] });
      expect(names.filter(name => name.startsWith('memory/')).sort()).toEqual(
        [
          `memory/${TENANT_ID}/MEMORY.md`,
          `memory/${mine}/MEMORY.md`,
          `memory/${TENANT_ID}__trips/MEMORY.md`,
          `memory/${TENANT_ID}__trips/memory/2026-09-01.md`,
        ].sort(),
      );
    });

    it('takes only owned persona vaults without instance data', async () => {
      const mine = vaultFilesystemNamespace(TENANT_ID, personaVaultNamespace('Researcher'));
      await vault(TENANT_ID, { 'MEMORY.md': '# Shared\n' });
      await vault(mine, { 'MEMORY.md': '# Mine\n' });
      await vault(`${TENANT_ID}__trips`, { 'MEMORY.md': '# Trips\n' });
      const names = await exportedNames({ includeInstanceData: false, owned: ['Researcher'] });
      expect(names.filter(name => name.startsWith('memory/'))).toEqual([`memory/${mine}/MEMORY.md`]);
    });

    it('finds the directory of a tenant whose id is not filesystem safe', async () => {
      await vault('acme_corp', { 'MEMORY.md': '# Acme\n' });
      await vault('acme_corpus', { 'MEMORY.md': '# Different tenant\n' });
      const names = await exportedNames({ tenantId: 'acme.corp' });
      expect(names.filter(name => name.startsWith('memory/'))).toEqual(['memory/acme_corp/MEMORY.md']);
    });

    it('never follows a link out of the vault', async () => {
      await vault(TENANT_ID, {});
      await writeFile(join(scratch, 'outside.md'), 'outside the vault\n');
      await symlink(join(scratch, 'outside.md'), join(memoryDir, TENANT_ID, 'MEMORY.md'));
      const names = await exportedNames({});
      expect(names.filter(name => name.startsWith('memory/'))).toEqual([]);
    });
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
      const sessions = z
        .array(z.object({ turns: z.array(z.object({ events: z.array(z.unknown()) })) }))
        .parse(JSON.parse(zipEntryText(entries, 'sessions.json')));
      expect(sessions).toHaveLength(SESSION_COUNT);
      const totalEvents = sessions.reduce(
        (sum, session) => sum + session.turns.reduce((turnSum, turn) => turnSum + turn.events.length, 0),
        0,
      );
      expect(totalEvents).toBe(SESSION_COUNT * EVENTS_PER_TURN);
      expect(z.array(z.unknown()).parse(JSON.parse(zipEntryText(entries, 'chats.json')))).toHaveLength(SESSION_COUNT);
    } finally {
      await close();
    }
  }, 300_000);
});
