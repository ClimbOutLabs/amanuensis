import { HTTPException } from 'hono/http-exception';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import {
  makeCreateTurnInput,
  makeModelMessageEvent,
  makeTurnCreatedEvent,
} from '../../../../trueforge-core/tests/agent-session/testHelpers';

import type { Authenticator } from '../../../src/auth/authenticator';
import type { RequestContext } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import { CommonChatExportFileSchema } from '../../../src/dataExport/commonChatFormat';
import { SentinelAuditStore } from '../../../src/db/sentinelAuditStore';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqlitePersonaStore } from '../../../src/db/sqlite/persona-store/SqlitePersonaStore';
import { SqlitePersonalizationStore } from '../../../src/db/sqlite/personalization-store/SqlitePersonalizationStore';
import { SqliteScheduleStore } from '../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { SqliteSentinelSettingsStore } from '../../../src/db/sqlite/sentinel-settings-store/SqliteSentinelSettingsStore';
import { SqliteSpaceStore } from '../../../src/db/sqlite/space-store/SqliteSpaceStore';
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import { SqliteTurnArtifactStore } from '../../../src/db/sqlite/turn-artifact-store/SqliteTurnArtifactStore';
import { personaKnowledgeLocation } from '../../../src/personaKnowledge/knowledgePaths';
import { openPersonaKnowledgeRepository } from '../../../src/personaKnowledge/sqliteKnowledgeRepository';
import { startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { readZipEntries, zipEntryJson, zipEntryText } from '../../fixtures/zipReader';

const TENANT_ID = 'default';
const EXPORT_PATH = '/api/v1/data/export';

// Planted stored secrets: each one lives in exactly one store, and some are
// also quoted inside user content. None of them may appear in the archive.
const PROVIDER_API_KEY = 'sk-test-provider-key-1234567890abcdef';
const CONNECTOR_HEADER_SECRET = 'test-header-secret-value-abcdef123456';
const OAUTH_ACCESS_TOKEN = 'test-oauth-access-token-abcdef123456';
// Not stored anywhere: only the credential-pattern layer can catch it.
const PASTED_GITHUB_TOKEN = ['ghp', 'pastedtoken1234567890abcdef'].join('_');

const headerAuthenticator: Authenticator = {
  authenticate: c => {
    const user = c.req.header('x-test-user');
    if (user === undefined) {
      return Promise.reject(new HTTPException(401, { message: 'Authentication required' }));
    }
    const context: RequestContext = {
      tenant_id: TENANT_ID,
      subject: { id: user, type: 'user', display_name: user },
      roles: [],
      user_credential: null,
    };
    return Promise.resolve(context);
  },
};

function asUser(user: string): RequestInit {
  return { headers: { 'x-test-user': user } };
}

function subject(user: string) {
  return { subject_id: user, subject_type: 'user' as const, subject_display_name: user };
}

async function seedSession(
  server: ApprovalTestServer,
  input: { user: string; sessionId: string; folderId?: string; userText: string; assistantText: string },
): Promise<void> {
  const store = server.sessionStore();
  await store.createSession({
    tenant_id: TENANT_ID,
    session_id: input.sessionId,
    created_by_subject: subject(input.user),
    agent: {
      type: 'inline',
      spec: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
    },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
  if (input.folderId !== undefined) {
    await store.setSessionFolder({
      tenant_id: TENANT_ID,
      session_id: input.sessionId,
      created_by: input.user,
      folder_id: input.folderId,
    });
  }
  await store.createTurn(
    makeCreateTurnInput({
      sessionId: input.sessionId,
      turnId: `${input.sessionId}-turn-1`,
      new_context_appends: [
        {
          thread_id: 'main',
          context: [
            { role: 'user', content: input.userText },
            { role: 'assistant', content: input.assistantText },
          ],
          current_context_usage: null,
        },
      ],
    }),
  );
  await store.appendToEvents({
    session_id: input.sessionId,
    turn_id: `${input.sessionId}-turn-1`,
    events: [makeTurnCreatedEvent(`${input.sessionId}-turn-1`), makeModelMessageEvent()],
  });
}

describe('Data export route', () => {
  let server: ApprovalTestServer;
  let scratchDir: string;
  let memoryDir: string;
  let knowledgeDir: string;
  const originalConfig = {
    MEMORY_MARKDOWN_DIR: configuration.MEMORY_MARKDOWN_DIR,
    PERSONA_KNOWLEDGE_DIR: configuration.PERSONA_KNOWLEDGE_DIR,
    DATA_EXPORT_MAX_BYTES: configuration.DATA_EXPORT_MAX_BYTES,
  };

  beforeAll(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'tfy-data-export-'));
    memoryDir = join(scratchDir, 'memory');
    knowledgeDir = join(scratchDir, 'knowledge');
    configuration.MEMORY_MARKDOWN_DIR = memoryDir;
    configuration.PERSONA_KNOWLEDGE_DIR = knowledgeDir;

    server = await startApprovalTestServer({ authenticator: headerAuthenticator });
    const db = server.db();

    // Folder + sessions: alice has one in a folder, bob has his own.
    const sessionStore = server.sessionStore();
    const folder = await sessionStore.createSessionFolder({
      tenant_id: TENANT_ID,
      folder_id: 'folder-1',
      created_by: 'alice',
      name: 'Research',
    });
    expect(folder.name).toBe('Research');
    await seedSession(server, {
      user: 'alice',
      sessionId: 'alice-session-1',
      folderId: 'folder-1',
      userText: `My key is ${PROVIDER_API_KEY} please use it`,
      assistantText: `Noted. Also saw this token: ${PASTED_GITHUB_TOKEN}`,
    });
    await seedSession(server, {
      user: 'bob',
      sessionId: 'bob-session-1',
      userText: 'bob private question',
      assistantText: 'bob private answer',
    });

    // Agent + schedule (alice) and a schedule owned by bob.
    const agentStore = new SqliteAgentStore(db);
    const agent = await agentStore.createAgent({
      tenant_id: TENANT_ID,
      created_by_subject: subject('alice'),
      name: 'reporter',
      description: 'Test agent.',
      manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
      external_id: null,
    });
    const scheduleStore = new SqliteScheduleStore(db);
    await scheduleStore.createScheduleAndRun({
      tenant_id: TENANT_ID,
      agent_id: agent.id,
      agent_name: 'reporter',
      name: 'alice-daily',
      manifest: { task: 'Write the daily summary', cron: '0 9 * * *', timezone: 'UTC', status: 'active' },
      created_by_subject: subject('alice'),
      runFrom: new Date(),
    });
    await scheduleStore.createScheduleAndRun({
      tenant_id: TENANT_ID,
      agent_id: agent.id,
      agent_name: 'reporter',
      name: 'bob-weekly',
      manifest: { task: 'Bob weekly task', cron: '0 10 * * 1', timezone: 'UTC', status: 'paused' },
      created_by_subject: subject('bob'),
      runFrom: new Date(),
    });

    // Persona + personalization + knowledge.
    const personaStore = new SqlitePersonaStore(db);
    await personaStore.createPersona({
      tenant_id: TENANT_ID,
      created_by: 'alice',
      id: 'persona-1',
      display_name: 'Researcher',
      updated_by: 'alice',
      aliases: [],
      instructions: 'You research carefully.',
      model_name: 'test-provider/test-model',
    });
    await personaStore.createPersona({
      tenant_id: TENANT_ID,
      created_by: 'bob',
      id: 'persona-bob',
      display_name: 'Bob Persona',
      updated_by: 'bob',
      aliases: [],
      instructions: 'Bob only.',
      model_name: 'test-provider/test-model',
    });
    await new SqlitePersonalizationStore(db).upsertProfile({
      tenant_id: TENANT_ID,
      created_by: 'alice',
      updated_by: 'alice',
      assistant_name: 'Helper',
      assistant_identity: null,
      voice_guidance: null,
      user_profile: 'Alice likes concise answers.',
      pinned_preferences: ['concise'],
      learned_profile: null,
      learning_enabled: false,
    });
    const knowledgeRepo = openPersonaKnowledgeRepository({
      dbPath: personaKnowledgeLocation({ knowledgeDir, tenantId: TENANT_ID, personaId: 'persona-1' }).dbPath,
    });
    const document = knowledgeRepo.createDocument({
      title: 'Field notes',
      titleExplicit: true,
      source_kind: 'text',
      source_label: 'notes.txt',
      source_url: null,
    });
    knowledgeRepo.setDocumentChunks({
      documentId: document.id,
      chunks: [{ text: 'Knowledge chunk text about tide pools.', embedding: new Float32Array(384) }],
    });
    knowledgeRepo.close();

    // Space with two revisions.
    const spaceStore = new SqliteSpaceStore(db);
    await spaceStore.createSpace({
      tenant_id: TENANT_ID,
      created_by: 'alice',
      id: 'space-1',
      expected_aggregate_revision: 0,
      name: 'Trip plan',
      purpose: 'Plan the trip',
      status: 'active',
      body: 'First version body',
      format: 'markdown',
    });
    await spaceStore.updateSpace({
      tenant_id: TENANT_ID,
      created_by: 'alice',
      space_id: 'space-1',
      expected_revision: 1,
      expected_aggregate_revision: 1,
      name: 'Trip plan',
      purpose: 'Plan the trip',
      status: 'active',
      body: 'Second version body',
      format: 'markdown',
    });

    // Connector with header auth + OAuth token + model provider key.
    const mcpStore = new SqliteMcpServerStore(db);
    const connector = await mcpStore.createServer({
      tenant_id: TENANT_ID,
      name: 'planted-connector',
      first_party: false,
      manifest: {
        type: 'remote',
        name: 'planted-connector',
        url: 'https://connector.example.com/mcp',
        description: 'Connector with credentials.',
        auth: { type: 'header', headers: { Authorization: `Bearer ${CONNECTOR_HEADER_SECRET}` } },
      },
    });
    await new SqliteOAuthTokenStore(db).saveToken({
      id: connector.id,
      userRef: 'alice',
      token: {
        accessToken: OAUTH_ACCESS_TOKEN,
        refreshToken: null,
        expiresAt: '2999-01-01T00:00:00.000Z',
        scope: null,
      },
    });
    await new SqliteModelProviderStore(db).upsertProvider({
      tenant_id: TENANT_ID,
      name: 'planted-provider',
      manifest: {
        type: 'custom',
        name: 'planted-provider',
        base_url: 'https://provider.example.com/v1',
        auth: { api_key: PROVIDER_API_KEY },
        models: [
          {
            model_id: 'planted-model',
            name: 'planted-model',
            properties: { context_length: 128000, max_output_tokens: 4096, reasoning_efforts: ['none'] },
          },
        ],
      },
    });

    // Settings.
    await new SqliteGlobalSettingsStore(db).setSetting({ key: 'export_test_setting', value: 'enabled' });
    await new SqliteSentinelSettingsStore(db).patch({
      tenant_id: TENANT_ID,
      created_by: 'alice',
      offline_mode: true,
      tier2_auto_allow: undefined,
      search_without_asking: undefined,
    });

    // Uploaded files: one text artifact quoting the OAuth token, one binary.
    const artifactStore = new SqliteTurnArtifactStore(db);
    await artifactStore.recordStoredArtifact({
      tenant_id: TENANT_ID,
      session_id: 'alice-session-1',
      turn_id: 'alice-session-1-turn-1',
      path: 'notes.txt',
      name: 'notes.txt',
      data: Buffer.from(`remember the token ${OAUTH_ACCESS_TOKEN}`),
      mime: 'text/plain',
    });
    await artifactStore.recordStoredArtifact({
      tenant_id: TENANT_ID,
      session_id: 'alice-session-1',
      turn_id: 'alice-session-1-turn-1',
      path: 'blob.bin',
      name: 'blob.bin',
      data: Buffer.from([0x00, 0x9f, 0xff, 0x10, 0x42]),
      mime: 'application/octet-stream',
    });

    // Markdown memory: tenant vault plus a persona vault, with a derived cache that must stay behind.
    await mkdir(join(memoryDir, TENANT_ID, 'memory'), { recursive: true });
    await writeFile(join(memoryDir, TENANT_ID, 'MEMORY.md'), '# Memory\n\nThe connector secret is in the vault.\n');
    await writeFile(
      join(memoryDir, TENANT_ID, 'memory', '2026-10-01.md'),
      `## 2026-10-01T10:00:00.000Z\n\nHeader secret: ${CONNECTOR_HEADER_SECRET}\n`,
    );
    await writeFile(join(memoryDir, TENANT_ID, '.vault-tombstones.md'), '<!-- tombstones -->\n');
    await writeFile(join(memoryDir, TENANT_ID, '.embeddings.json'), '{"derived":true}\n');
    await mkdir(join(memoryDir, `${TENANT_ID}__persona-Researcher`, 'memory'), { recursive: true });
    await writeFile(join(memoryDir, `${TENANT_ID}__persona-Researcher`, 'MEMORY.md'), '# Persona memory\n');
  }, 120_000);

  afterAll(async () => {
    await server.close();
    configuration.MEMORY_MARKDOWN_DIR = originalConfig.MEMORY_MARKDOWN_DIR;
    configuration.PERSONA_KNOWLEDGE_DIR = originalConfig.PERSONA_KNOWLEDGE_DIR;
    configuration.DATA_EXPORT_MAX_BYTES = originalConfig.DATA_EXPORT_MAX_BYTES;
    await rm(scratchDir, { recursive: true, force: true });
  });

  async function exportZip(user: string, query = ''): Promise<Buffer> {
    const response = await server.request(`${EXPORT_PATH}${query}`, asUser(user));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/zip');
    return Buffer.from(await response.arrayBuffer());
  }

  it('requires authentication', async () => {
    expect((await server.request(EXPORT_PATH)).status).toBe(401);
  });

  it('exports every section for the caller, in the common chat format', async () => {
    const zipBytes = await exportZip('alice');
    const entries = readZipEntries(zipBytes);
    const names = entries.map(entry => entry.name);

    const manifest = zipEntryJson(entries, 'manifest.json') as {
      format: string;
      schema_version: number;
      include_uploads: boolean;
    };
    expect(manifest.format).toBe('aman-export');
    expect(manifest.schema_version).toBe(1);
    expect(manifest.include_uploads).toBe(false);

    // chats.json is the common chat format.
    const chats = CommonChatExportFileSchema.parse(JSON.parse(zipEntryText(entries, 'chats.json')));
    expect(chats).toHaveLength(1);
    expect(chats[0]?.folder).toBe('Research');
    expect(chats[0]?.messages.map(message => message.author)).toEqual(['you', 'assistant']);
    expect(chats[0]?.messages[0]?.text).toContain('please use it');

    // Full-fidelity sessions with events, and artifact index rows.
    const sessions = zipEntryJson(entries, 'sessions.json') as {
      session: { session_id: string };
      turns: { events: unknown[] }[];
      artifacts: { path: string }[];
    }[];
    expect(sessions.map(entry => entry.session.session_id)).toEqual(['alice-session-1']);
    expect(sessions[0]?.turns).toHaveLength(1);
    expect(sessions[0]?.turns[0]?.events.length).toBeGreaterThanOrEqual(2);
    expect(sessions[0]?.artifacts.map(artifact => artifact.path).sort()).toEqual(['blob.bin', 'notes.txt']);

    expect((zipEntryJson(entries, 'folders.json') as { name: string }[]).map(folder => folder.name)).toEqual([
      'Research',
    ]);

    const personas = zipEntryJson(entries, 'personas.json') as {
      persona: { display_name: string };
      knowledge: { documents: { chunks: { text: string }[] }[] };
    }[];
    expect(personas.map(entry => entry.persona.display_name)).toEqual(['Researcher']);
    expect(personas[0]?.knowledge.documents[0]?.chunks[0]?.text).toContain('tide pools');

    const personalization = zipEntryJson(entries, 'personalization.json') as { assistant_name: string | null };
    expect(personalization.assistant_name).toBe('Helper');

    const spaces = zipEntryJson(entries, 'spaces.json') as { space: { name: string }; revisions: { body: string }[] }[];
    expect(spaces).toHaveLength(1);
    expect(spaces[0]?.revisions.map(revision => revision.body)).toEqual(['First version body', 'Second version body']);

    const schedules = zipEntryJson(entries, 'schedules.json') as { name: string }[];
    expect(schedules.map(schedule => schedule.name)).toEqual(['alice-daily']);

    const connectors = zipEntryJson(entries, 'connectors.json') as {
      name: string;
      manifest: Record<string, unknown>;
    }[];
    const planted = connectors.find(connector => connector.name === 'planted-connector');
    expect(planted).toBeDefined();
    expect(planted?.manifest).not.toHaveProperty('auth');

    const settings = zipEntryJson(entries, 'settings.json') as {
      global: { key: string; value: string }[];
      permission_settings: { offline_mode: boolean };
    };
    expect(settings.global).toContainEqual({ key: 'export_test_setting', value: 'enabled' });
    expect(settings.permission_settings.offline_mode).toBe(true);

    // Memory files: verbatim layout, derived cache excluded.
    expect(names).toContain('memory/default/MEMORY.md');
    expect(names).toContain('memory/default/memory/2026-10-01.md');
    expect(names).toContain('memory/default/.vault-tombstones.md');
    expect(names).toContain('memory/default__persona-Researcher/MEMORY.md');
    expect(names.some(name => name.includes('.embeddings.json'))).toBe(false);

    // No uploaded file bytes without the tick.
    expect(names.some(name => name.startsWith('files/'))).toBe(false);
  });

  it('keeps every planted secret out of the archive', async () => {
    const zipBytes = await exportZip('alice', '?include_uploads=true');
    for (const secret of [PROVIDER_API_KEY, CONNECTOR_HEADER_SECRET, OAUTH_ACCESS_TOKEN, PASTED_GITHUB_TOKEN]) {
      expect(zipBytes.includes(Buffer.from(secret))).toBe(false);
    }
    // The scrubbed content itself still ships.
    const entries = readZipEntries(zipBytes);
    const chats = zipEntryText(entries, 'chats.json');
    expect(chats).toContain('please use it');
    expect(chats).toContain('[redacted]');
  });

  it("never includes another user's data", async () => {
    const zipBytes = await exportZip('alice');
    for (const marker of ['bob-session-1', 'bob private question', 'Bob Persona', 'bob-weekly', 'Bob weekly task']) {
      expect(zipBytes.includes(Buffer.from(marker))).toBe(false);
    }
    const bobZip = await exportZip('bob');
    const bobSessions = zipEntryJson(readZipEntries(bobZip), 'sessions.json') as { session: { session_id: string } }[];
    expect(bobSessions.map(entry => entry.session.session_id)).toEqual(['bob-session-1']);
  });

  it('includes uploaded files only when requested, scrubbing text payloads', async () => {
    const withUploads = readZipEntries(await exportZip('alice', '?include_uploads=true'));
    const names = withUploads.map(entry => entry.name);
    expect(names).toContain('files/alice-session-1/notes.txt');
    expect(names).toContain('files/alice-session-1/blob.bin');
    const notes = zipEntryText(withUploads, 'files/alice-session-1/notes.txt');
    expect(notes).toContain('remember the token');
    expect(notes).not.toContain(OAUTH_ACCESS_TOKEN);
    const blob = withUploads.find(entry => entry.name === 'files/alice-session-1/blob.bin');
    expect(blob?.data.equals(Buffer.from([0x00, 0x9f, 0xff, 0x10, 0x42]))).toBe(true);
  });

  it('enforces the size cap instead of shipping a truncated archive', async () => {
    configuration.DATA_EXPORT_MAX_BYTES = 512;
    try {
      const response = await server.request(EXPORT_PATH, asUser('alice'));
      // The download must fail visibly: either reading the body errors, or
      // the bytes are an incomplete archive with no end record.
      let bytes: Buffer | undefined;
      try {
        bytes = Buffer.from(await response.arrayBuffer());
      } catch {
        bytes = undefined;
      }
      if (bytes !== undefined) {
        expect(() => readZipEntries(bytes)).toThrow();
      }
    } finally {
      configuration.DATA_EXPORT_MAX_BYTES = originalConfig.DATA_EXPORT_MAX_BYTES;
    }
  });

  it('records one audit row per export', async () => {
    await exportZip('alice');
    const auditStore = new SentinelAuditStore(server.db());
    const rows = await auditStore.list({
      tenant_id: TENANT_ID,
      created_by: 'alice',
      conversation_id: '',
      limit: 100,
      offset: 0,
    });
    const exports = rows.filter(row => row.tool_name === 'data_export');
    expect(exports.length).toBeGreaterThanOrEqual(1);
    expect(exports[0]?.description).not.toContain('tide pools');
  });
});
