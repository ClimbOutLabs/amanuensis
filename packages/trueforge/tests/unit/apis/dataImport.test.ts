import { HTTPException } from 'hono/http-exception';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Transaction } from 'kysely';
import type { Authenticator } from '../../../src/auth/authenticator';
import type { RequestContext } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import { ZipStreamWriter } from '../../../src/dataExport/zipStreamWriter';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
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
import { resolveMcpAuthStatus } from '../../../src/schemas/mcpServer';
import { startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { CollectingWritable, exportInstanceArchive } from '../../fixtures/dataTransferExport';
import { SEED_IDS, seedRichInstance, type DataTransferSeedStores } from '../../fixtures/dataTransferSeed';
import { readZipEntries } from '../../fixtures/zipReader';

const TENANT_ID = 'default';
const IMPORT_PATH = '/api/v1/data/import';

const headerAuthenticator: Authenticator = {
  authenticate: c => {
    const user = c.req.header('x-test-user');
    if (user === undefined) {
      return Promise.reject(new HTTPException(401, { message: 'Authentication required' }));
    }
    const context: RequestContext = {
      tenant_id: TENANT_ID,
      subject: { id: user, type: 'user', display_name: user },
      roles: c.req.header('x-test-admin') === 'yes' ? ['admin'] : [],
      user_credential: null,
    };
    return Promise.resolve(context);
  },
};

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

jest.setTimeout(120000);

describe('Data import route', () => {
  let sourceServer: ApprovalTestServer;
  let targetServer: ApprovalTestServer;
  let scratchDir: string;
  let archive: Buffer;
  const originalConfig = {
    MEMORY_MARKDOWN_DIR: configuration.MEMORY_MARKDOWN_DIR,
    PERSONA_KNOWLEDGE_DIR: configuration.PERSONA_KNOWLEDGE_DIR,
    DATA_IMPORT_MAX_BYTES: configuration.DATA_IMPORT_MAX_BYTES,
  };

  beforeAll(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'tfy-data-import-api-'));
    const sourceMemoryDir = join(scratchDir, 'source-memory');
    const sourceKnowledgeDir = join(scratchDir, 'source-knowledge');
    const targetMemoryDir = join(scratchDir, 'target-memory');
    const targetKnowledgeDir = join(scratchDir, 'target-knowledge');
    await mkdir(sourceMemoryDir, { recursive: true });
    await mkdir(targetMemoryDir, { recursive: true });

    configuration.MEMORY_MARKDOWN_DIR = sourceMemoryDir;
    configuration.PERSONA_KNOWLEDGE_DIR = sourceKnowledgeDir;
    sourceServer = await startApprovalTestServer({ authenticator: headerAuthenticator });
    const db = sourceServer.db();
    const stores: DataTransferSeedStores<Transaction<Database>> = {
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
    await seedRichInstance({
      stores,
      tenantId: TENANT_ID,
      userId: 'alice',
      memoryDir: sourceMemoryDir,
      knowledgeDir: sourceKnowledgeDir,
    });
    const exported = await exportInstanceArchive({
      instance: { stores, memoryDir: sourceMemoryDir, knowledgeDir: sourceKnowledgeDir },
      tenantId: TENANT_ID,
      subjectId: 'alice',
    });
    // The embedding model is not available to unit tests; the service tests cover knowledge.
    archive = await repack(exported, entries => {
      const personas = JSON.parse(entries.get('personas.json')?.toString('utf8') ?? '[]') as {
        knowledge: { documents: unknown[] };
      }[];
      for (const entry of personas) {
        entry.knowledge.documents = [];
      }
      entries.set('personas.json', Buffer.from(JSON.stringify(personas)));
    });

    configuration.MEMORY_MARKDOWN_DIR = targetMemoryDir;
    configuration.PERSONA_KNOWLEDGE_DIR = targetKnowledgeDir;
    configuration.DATA_IMPORT_MAX_BYTES = 1024 * 1024;
    targetServer = await startApprovalTestServer({ authenticator: headerAuthenticator });
  });

  afterAll(async () => {
    await sourceServer.close();
    await targetServer.close();
    configuration.MEMORY_MARKDOWN_DIR = originalConfig.MEMORY_MARKDOWN_DIR;
    configuration.PERSONA_KNOWLEDGE_DIR = originalConfig.PERSONA_KNOWLEDGE_DIR;
    configuration.DATA_IMPORT_MAX_BYTES = originalConfig.DATA_IMPORT_MAX_BYTES;
    await rm(scratchDir, { recursive: true, force: true });
  });

  function postImport(
    user: string | undefined,
    body: Buffer,
    options: { admin?: boolean; contentType?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': options.contentType ?? 'application/zip' };
    if (user !== undefined) {
      headers['x-test-user'] = user;
    }
    if (options.admin ?? true) {
      headers['x-test-admin'] = 'yes';
    }
    return targetServer.request(IMPORT_PATH, { method: 'POST', headers, body });
  }

  it('requires authentication', async () => {
    const response = await postImport(undefined, archive);
    expect(response.status).toBe(401);
  });

  it('is for administrators only', async () => {
    const response = await postImport('member', archive, { admin: false });
    expect(response.status).toBe(403);
  });

  it('wants the archive sent as application/zip', async () => {
    const response = await postImport('carol', archive, { contentType: 'application/json' });
    expect(response.status).toBe(415);
  });

  it('imports the archive for the signed-in user and reports the summary', async () => {
    const response = await postImport('bob', archive);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        chats: number;
        memories: number;
        personas: number;
        spaces: number;
        schedules: number;
        schedules_off: boolean;
        summary: string;
      };
    };
    expect(body.data.chats).toBe(3);
    expect(body.data.memories).toBe(3);
    expect(body.data.personas).toBe(2);
    expect(body.data.spaces).toBe(1);
    expect(body.data.schedules).toBe(2);
    expect(body.data.schedules_off).toBe(true);
    expect(body.data.summary).toContain(
      'Imported 3 chats, 3 memories, 2 personas, 1 space, 1 agent, 2 schedules (off).',
    );
    expect(body.data.summary).toContain('Not imported: model keys, connector sign-ins, Always allow choices.');

    // Everything landed owned by bob with ids kept, schedules off, and the
    // dcr connector reading "needs credentials".
    const session = await targetServer.sessionStore().getSession({
      tenant_id: TENANT_ID,
      session_id: SEED_IDS.sessionMain,
    });
    expect(session?.created_by_subject.subject_id).toBe('bob');
    const scheduleStore = new SqliteScheduleStore(targetServer.db());
    const schedule = await scheduleStore.getSchedule({ tenant_id: TENANT_ID, id: SEED_IDS.scheduleDaily });
    expect(schedule?.status).toBe('paused');
    const mcpStore = new SqliteMcpServerStore(targetServer.db());
    const servers = await mcpStore.listServers({ tenant_id: TENANT_ID, names: undefined });
    const dcr = servers.find(server => server.name === 'dcr-connector');
    expect(dcr !== undefined && resolveMcpAuthStatus({ manifest: dcr.manifest }).status).toBe('auth_required');
  });

  it('refuses a second import into the now non-empty instance', async () => {
    const response = await postImport('bob', archive);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('already has');
  });

  it('refuses a body that is not an export archive', async () => {
    const response = await postImport('carol', Buffer.from('not a zip'));
    expect(response.status).toBe(400);
  });

  it('refuses an export made by a newer version', async () => {
    const newer = await repack(archive, entries => {
      const manifest = JSON.parse(entries.get('manifest.json')?.toString('utf8') ?? '{}') as Record<string, unknown>;
      manifest['schema_version'] = 2;
      entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    });
    const response = await postImport('carol', newer);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('newer version of Aman');
  });

  it('refuses an upload over the import size limit', async () => {
    const response = await postImport('carol', Buffer.alloc(1024 * 1024 + 1, 7));
    expect(response.status).toBe(413);
  });
});
