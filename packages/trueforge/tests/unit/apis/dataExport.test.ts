import { HTTPException } from 'hono/http-exception';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import { z } from 'zod';
import { internalSystemMessage } from '../../../../trueforge-core/src/core/runtime/contextUtils';
import {
  makeCreateTurnInput,
  makeModelMessageEvent,
  makeTurnCreatedEvent,
} from '../../../../trueforge-core/tests/agent-session/testHelpers';

import type { Authenticator } from '../../../src/auth/authenticator';
import type { RequestContext } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import { CommonChatExportFileSchema } from '../../../src/dataExport/commonChatFormat';
import { EXPORT_SCHEMA_VERSION } from '../../../src/dataExport/exportService';
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
import { personaVaultNamespace, vaultFilesystemNamespace } from '../../../src/runtime/memory/markdownMemoryFiles';
import { startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { legacySessionsOf } from '../../fixtures/legacySessions';
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
const CONNECTOR_PATH_TOKEN = ['ghp', 'connectorpathtoken1234567890'].join('_');
const CONNECTOR_QUERY_SECRET = 'query-secret-value-9876543210';
const APPROVAL_TOKEN_ID = 'approval-token-id-should-not-ship';
const AUTH_URL = 'https://login.example.com/authorize?state=should-not-ship';

const RESEARCHER_VAULT = vaultFilesystemNamespace(TENANT_ID, personaVaultNamespace('Researcher'));
const BOB_VAULT = vaultFilesystemNamespace(TENANT_ID, personaVaultNamespace('Bob Persona'));

/** `x-test-user` names the caller; `x-test-admin` gives them the administrator role. */
const headerAuthenticator: Authenticator = {
  authenticate: c => {
    const user = c.req.header('x-test-user');
    if (user === undefined) {
      return Promise.reject(new HTTPException(401, { message: 'Authentication required' }));
    }
    const context: RequestContext = {
      tenant_id: TENANT_ID,
      subject: { id: user, type: 'user', display_name: user },
      roles: c.req.header('x-test-admin') === undefined ? [] : ['admin'],
      user_credential: null,
    };
    return Promise.resolve(context);
  },
};

function subject(user: string) {
  return { subject_id: user, subject_type: 'user' as const, subject_display_name: user };
}

const ManifestSchema = z.object({
  format: z.string(),
  schema_version: z.number(),
  tenant_id: z.string(),
  include_uploads: z.boolean(),
  sections: z.array(z.string()),
  redactions: z.number(),
  memory: z.object({
    backend: z.string(),
    status: z.string(),
    vaults: z.number(),
    shared_vaults_included: z.boolean(),
  }),
});

const SessionEntrySchema = z.object({
  session: z.object({
    session_id: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    last_activity_timestamp_ms: z.number(),
    metrics: z.object({ total_turns: z.number() }),
  }),
  turns: z.array(
    z.object({
      turn: z.object({ created_at: z.string(), updated_at: z.string(), snapshot: z.record(z.string(), z.unknown()) }),
      events: z.array(z.object({ type: z.string() }).passthrough()),
    }),
  ),
  artifacts: z.array(z.object({ path: z.string(), created_at: z.string(), updated_at: z.string() })),
});

const Timestamped = z.object({ created_at: z.string(), updated_at: z.string() });

async function seedSession(
  server: ApprovalTestServer,
  input: {
    user: string;
    sessionId: string;
    folderId?: string;
    userText: string;
    assistantText: string;
    agentId?: string;
  },
): Promise<void> {
  const store = server.sessionStore();
  await store.createSession({
    tenant_id: TENANT_ID,
    session_id: input.sessionId,
    created_by_subject: subject(input.user),
    agent:
      input.agentId === undefined
        ? {
            type: 'inline',
            spec: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
          }
        : { type: 'reference', id: input.agentId, name: 'reporter' },
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
      sandbox_info: { sandbox_id: 'sandbox-handle-should-not-ship' },
      new_context_appends: [
        {
          thread_id: 'main',
          context: [
            { role: 'user', content: input.userText },
            internalSystemMessage('Host note: the user is on a trip.'),
            { role: 'assistant', content: input.assistantText },
            {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{}' },
                  tool_info: {
                    type: 'mcp',
                    mcp_server_id: '',
                    mcp_server_name: '',
                    original_tool_name: 'lookup',
                    approval_token_id: APPROVAL_TOKEN_ID,
                  },
                },
              ],
            },
          ],
          current_context_usage: null,
        },
      ],
    }),
  );
  await store.appendToEvents({
    session_id: input.sessionId,
    turn_id: `${input.sessionId}-turn-1`,
    events: [
      makeTurnCreatedEvent(`${input.sessionId}-turn-1`),
      makeModelMessageEvent(),
      {
        type: 'sandbox.created',
        id: 'evt-sandbox',
        created_at: new Date().toISOString(),
        sandbox_id: 'sandbox-handle-should-not-ship',
        thread_id: null,
      },
      {
        type: 'mcp.auth_required',
        id: 'evt-auth',
        created_at: new Date().toISOString(),
        thread_id: null,
        mcp_servers: [{ id: 'server-1', name: 'planted-connector', auth_url: AUTH_URL }],
      },
    ],
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

    // Agents: alice has one, bob has one of his own.
    const agentStore = new SqliteAgentStore(db);
    const agent = await agentStore.createAgent({
      host_managed: false,
      tenant_id: TENANT_ID,
      created_by_subject: subject('alice'),
      name: 'reporter',
      description: 'Test agent.',
      manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'Report daily.' }),
      external_id: 'reporter-external',
    });
    await agentStore.createAgent({
      host_managed: false,
      tenant_id: TENANT_ID,
      created_by_subject: subject('bob'),
      name: 'bob-agent',
      description: 'Bob only.',
      manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'Bob secret.' }),
      external_id: null,
    });

    // Folder + sessions: alice has one in a folder, bob has his own, and one bound to alice's agent.
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
    await seedSession(server, {
      user: 'bob',
      sessionId: 'bob-on-alice-agent',
      userText: 'bob asks the shared agent',
      assistantText: 'shared agent answer for bob',
      agentId: agent.id,
    });

    // Schedules: one each.
    const scheduleStore = new SqliteScheduleStore(db);
    await scheduleStore.createScheduleAndRun({
      tenant_id: TENANT_ID,
      agent_id: agent.id,
      agent_name: 'reporter',
      persona_id: null,
      name: 'alice-daily',
      manifest: { task: 'Write the daily summary', cron: '0 9 * * *', timezone: 'UTC', status: 'active' },
      created_by_subject: subject('alice'),
      runFrom: new Date(),
    });
    await scheduleStore.createScheduleAndRun({
      tenant_id: TENANT_ID,
      agent_id: agent.id,
      agent_name: 'reporter',
      persona_id: null,
      name: 'bob-weekly',
      manifest: { task: 'Bob weekly task', cron: '0 10 * * 1', timezone: 'UTC', status: 'paused' },
      created_by_subject: subject('bob'),
      runFrom: new Date(),
    });

    // Personas + personalization + knowledge.
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
      user_name: null,
      address_as: null,
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

    // Connector with header auth + credentials in its URL, an OAuth token, and a model provider key.
    const mcpStore = new SqliteMcpServerStore(db);
    const connector = await mcpStore.createServer({
      tenant_id: TENANT_ID,
      name: 'planted-connector',
      first_party: false,
      manifest: {
        type: 'remote',
        name: 'planted-connector',
        url: `https://user:pw@connector.example.com/mcp/${CONNECTOR_PATH_TOKEN}/v1?api=${CONNECTOR_QUERY_SECRET}#frag`,
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

    // Settings: an exported toggle, and one that must stay behind.
    const globalSettings = new SqliteGlobalSettingsStore(db);
    await globalSettings.setSetting({ key: 'tool_output_screen_enabled', value: 'true' });
    await globalSettings.setSetting({ key: 'export_test_unlisted_setting', value: 'enabled' });
    await new SqliteSentinelSettingsStore(db).patch({
      tenant_id: TENANT_ID,
      created_by: 'alice',
      offline_mode: true,
      tier2_auto_allow: undefined,
      search_without_asking: undefined,
      maps_without_asking: undefined,
    });

    // Uploaded files: a text artifact quoting the OAuth token, a binary, and a path that tries to escape.
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
    await artifactStore.recordStoredArtifact({
      tenant_id: TENANT_ID,
      session_id: 'alice-session-1',
      turn_id: 'alice-session-1-turn-1',
      path: '..\\..\\C:\\escape.txt',
      name: 'escape.txt',
      data: Buffer.from('escape attempt'),
      mime: 'text/plain',
    });

    // Markdown memory: the shared vault (with a derived cache that must stay behind and a sharing
    // config naming personas), both users' persona vaults, a topic vault, and a lookalike directory.
    await mkdir(join(memoryDir, TENANT_ID, 'memory'), { recursive: true });
    await writeFile(join(memoryDir, TENANT_ID, 'MEMORY.md'), '# Memory\n\nThe connector secret is in the vault.\n');
    await writeFile(
      join(memoryDir, TENANT_ID, 'memory', '2026-10-01.md'),
      `## 2026-10-01T10:00:00.000Z\n\nHeader secret: ${CONNECTOR_HEADER_SECRET}\n`,
    );
    await writeFile(join(memoryDir, TENANT_ID, '.vault-tombstones.md'), '<!-- tombstones -->\n');
    await writeFile(join(memoryDir, TENANT_ID, '.embeddings.json'), '{"derived":true}\n');
    await writeFile(join(memoryDir, TENANT_ID, '.vault-sharing.json'), '{"shares":{"Bob Persona":["trips"]}}\n');
    await mkdir(join(memoryDir, RESEARCHER_VAULT, 'memory'), { recursive: true });
    await writeFile(join(memoryDir, RESEARCHER_VAULT, 'MEMORY.md'), '# Researcher memory\n');
    await mkdir(join(memoryDir, BOB_VAULT, 'memory'), { recursive: true });
    await writeFile(join(memoryDir, BOB_VAULT, 'MEMORY.md'), '# Bob private memory\n');
    await mkdir(join(memoryDir, `${TENANT_ID}__trips`, 'memory'), { recursive: true });
    await writeFile(join(memoryDir, `${TENANT_ID}__trips`, 'MEMORY.md'), '# Trips\n');
    await mkdir(join(memoryDir, `${TENANT_ID}s-other`, 'memory'), { recursive: true });
    await writeFile(join(memoryDir, `${TENANT_ID}s-other`, 'MEMORY.md'), '# Another tenant\n');
  }, 120_000);

  afterAll(async () => {
    await server.close();
    configuration.MEMORY_MARKDOWN_DIR = originalConfig.MEMORY_MARKDOWN_DIR;
    configuration.PERSONA_KNOWLEDGE_DIR = originalConfig.PERSONA_KNOWLEDGE_DIR;
    configuration.DATA_EXPORT_MAX_BYTES = originalConfig.DATA_EXPORT_MAX_BYTES;
    await rm(scratchDir, { recursive: true, force: true });
  });

  function requestExport(user: string, options?: { uploads?: boolean; admin?: boolean }): Promise<Response> {
    return server.request(EXPORT_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user': user,
        ...(options?.admin === true ? { 'x-test-admin': 'yes' } : {}),
      },
      body: JSON.stringify(options?.uploads === true ? { include_uploads: true } : {}),
    });
  }

  async function exportZip(user: string, options?: { uploads?: boolean; admin?: boolean }): Promise<Buffer> {
    const response = await requestExport(user, options);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/zip');
    return Buffer.from(await response.arrayBuffer());
  }

  async function auditDescriptions(user: string): Promise<string[]> {
    const rows = await new SentinelAuditStore(server.db()).list({
      tenant_id: TENANT_ID,
      created_by: user,
      conversation_id: '',
      limit: 100,
      offset: 0,
    });
    return rows.filter(row => row.tool_name === 'data_export').map(row => row.description);
  }

  it('requires authentication', async () => {
    const response = await server.request(EXPORT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(401);
  });

  it('only accepts a JSON body, so a cross-site form cannot start an export', async () => {
    const asAlice = { 'x-test-user': 'alice' };
    const form = await server.request(EXPORT_PATH, {
      method: 'POST',
      headers: { ...asAlice, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'include_uploads=true',
    });
    expect(form.status).toBe(415);
    const plain = await server.request(EXPORT_PATH, {
      method: 'POST',
      headers: { ...asAlice, 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(plain.status).toBe(415);
    const none = await server.request(EXPORT_PATH, { method: 'POST', headers: asAlice });
    expect(none.status).toBe(415);
    const get = await server.request(EXPORT_PATH, { headers: asAlice });
    expect(get.status).toBe(404);
  });

  it('exports every section for the caller, in the common chat format', async () => {
    const entries = readZipEntries(await exportZip('alice', { admin: true }));
    const names = entries.map(entry => entry.name);

    const manifest = ManifestSchema.parse(zipEntryJson(entries, 'manifest.json'));
    expect(manifest.format).toBe('aman-export');
    expect(manifest.schema_version).toBe(EXPORT_SCHEMA_VERSION);
    expect(manifest.tenant_id).toBe(TENANT_ID);
    expect(manifest.include_uploads).toBe(false);
    expect(manifest.redactions).toBeGreaterThan(0);
    expect(manifest.sections).toEqual([
      'chats.json',
      'sessions/0001.json',
      'folders.json',
      'personas.json',
      'personalization.json',
      'spaces.json',
      'agents.json',
      'schedules.json',
      'connectors.json',
      'model_providers.json',
      'settings.json',
      'audit.json',
    ]);
    for (const section of manifest.sections) {
      expect(names).toContain(section);
    }
    expect(manifest.memory).toMatchObject({ backend: 'markdown', status: 'included', shared_vaults_included: true });

    // chats.json is the common chat format, and host notes are not chat.
    const chats = CommonChatExportFileSchema.parse(JSON.parse(zipEntryText(entries, 'chats.json')));
    expect(chats).toHaveLength(1);
    expect(chats[0]?.folder).toBe('Research');
    expect(chats[0]?.messages.map(message => message.author)).toEqual(['you', 'assistant']);
    expect(chats[0]?.messages[0]?.text).toContain('please use it');
    expect(zipEntryText(entries, 'chats.json')).not.toContain('Host note');

    // Full-fidelity sessions with events, and artifact index rows.
    const sessions = z.array(SessionEntrySchema).parse(legacySessionsOf(entries));
    expect(sessions.map(entry => entry.session.session_id)).toEqual(['alice-session-1']);
    expect(sessions[0]?.turns).toHaveLength(1);
    expect(sessions[0]?.turns[0]?.events.length).toBeGreaterThanOrEqual(2);
    expect(sessions[0]?.artifacts.map(artifact => artifact.path).sort()).toEqual([
      '..\\..\\C:\\escape.txt',
      'blob.bin',
      'notes.txt',
    ]);

    expect(
      z
        .array(z.object({ name: z.string() }).merge(Timestamped))
        .parse(zipEntryJson(entries, 'folders.json'))
        .map(folder => folder.name),
    ).toEqual(['Research']);

    const personas = z
      .array(
        z.object({
          persona: z.object({ display_name: z.string() }).merge(Timestamped),
          knowledge: z.object({ documents: z.array(z.object({ chunks: z.array(z.object({ text: z.string() })) })) }),
        }),
      )
      .parse(zipEntryJson(entries, 'personas.json'));
    expect(personas.map(entry => entry.persona.display_name)).toEqual(['Researcher']);
    expect(personas[0]?.knowledge.documents[0]?.chunks[0]?.text).toContain('tide pools');

    const personalization = z
      .object({ assistant_name: z.string().nullable() })
      .parse(zipEntryJson(entries, 'personalization.json'));
    expect(personalization.assistant_name).toBe('Helper');

    const spaces = z
      .array(
        z.object({
          space: z.object({ name: z.string() }).merge(Timestamped),
          revisions: z.array(z.object({ body: z.string() }).merge(Timestamped)),
        }),
      )
      .parse(zipEntryJson(entries, 'spaces.json'));
    expect(spaces).toHaveLength(1);
    expect(spaces[0]?.revisions.map(revision => revision.body)).toEqual(['First version body', 'Second version body']);

    const schedules = z
      .array(z.object({ name: z.string() }).merge(Timestamped))
      .parse(zipEntryJson(entries, 'schedules.json'));
    expect(schedules.map(schedule => schedule.name)).toEqual(['alice-daily']);

    const settings = z
      .object({
        instance: z.array(z.object({ key: z.string(), value: z.string() })),
        permission_settings: z.object({ offline_mode: z.boolean() }),
      })
      .parse(zipEntryJson(entries, 'settings.json'));
    expect(settings.instance).toEqual([{ key: 'tool_output_screen_enabled', value: 'true' }]);
    expect(settings.permission_settings.offline_mode).toBe(true);

    // No uploaded file bytes without the tick.
    expect(names.some(name => name.startsWith('files/'))).toBe(false);
  });

  it('exports the agents the caller manages, with full definitions and timestamps', async () => {
    const entries = readZipEntries(await exportZip('alice'));
    const agents = z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            description: z.string(),
            external_id: z.string().nullable(),
            created_by_subject: z.object({ subject_id: z.string() }),
            manifest: z.object({ instructions: z.string(), model: z.object({ name: z.string() }) }),
          })
          .merge(Timestamped),
      )
      .parse(zipEntryJson(entries, 'agents.json'));
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      name: 'reporter',
      description: 'Test agent.',
      external_id: 'reporter-external',
      created_by_subject: { subject_id: 'alice' },
      manifest: { instructions: 'Report daily.', model: { name: 'test-provider/test-model' } },
    });
    const bytes = zipEntryText(entries, 'agents.json');
    expect(bytes).not.toContain('bob-agent');
    expect(bytes).not.toContain('Bob secret.');
  });

  it('carries the timestamps and counters an import restores', async () => {
    const entries = readZipEntries(await exportZip('alice', { uploads: true }));
    const [entry] = z.array(SessionEntrySchema).parse(legacySessionsOf(entries));
    expect(Date.parse(entry?.session.created_at ?? '')).not.toBeNaN();
    expect(Date.parse(entry?.session.updated_at ?? '')).not.toBeNaN();
    expect(entry?.session.last_activity_timestamp_ms).toBeGreaterThan(0);
    expect(entry?.session.metrics.total_turns).toBeGreaterThanOrEqual(0);
    expect(Date.parse(entry?.turns[0]?.turn.created_at ?? '')).not.toBeNaN();
    expect(Date.parse(entry?.turns[0]?.turn.updated_at ?? '')).not.toBeNaN();
    for (const artifact of entry?.artifacts ?? []) {
      expect(Date.parse(artifact.created_at)).not.toBeNaN();
      expect(artifact.updated_at).toBe(artifact.created_at);
    }
  });

  it('takes only the memory the caller may export', async () => {
    const adminNames = readZipEntries(await exportZip('alice', { admin: true })).map(entry => entry.name);
    expect(adminNames).toContain(`memory/${TENANT_ID}/MEMORY.md`);
    expect(adminNames).toContain(`memory/${TENANT_ID}/memory/2026-10-01.md`);
    expect(adminNames).toContain(`memory/${TENANT_ID}/.vault-tombstones.md`);
    expect(adminNames).toContain(`memory/${RESEARCHER_VAULT}/MEMORY.md`);
    expect(adminNames).toContain(`memory/${TENANT_ID}__trips/MEMORY.md`);
    expect(adminNames.some(name => name.includes('.embeddings.json'))).toBe(false);
    expect(adminNames.some(name => name.includes('.vault-sharing.json'))).toBe(false);
    expect(adminNames.some(name => name.includes(BOB_VAULT))).toBe(false);
    expect(adminNames.some(name => name.includes(`${TENANT_ID}s-other`))).toBe(false);

    const memberEntries = readZipEntries(await exportZip('alice'));
    const memberMemory = memberEntries.map(entry => entry.name).filter(name => name.startsWith('memory/'));
    expect(memberMemory.every(name => name.startsWith(`memory/${RESEARCHER_VAULT}/`))).toBe(true);
    expect(memberMemory).toContain(`memory/${RESEARCHER_VAULT}/MEMORY.md`);
    expect(ManifestSchema.parse(zipEntryJson(memberEntries, 'manifest.json')).memory.shared_vaults_included).toBe(
      false,
    );
    const settings = z.object({ instance: z.array(z.unknown()) }).parse(zipEntryJson(memberEntries, 'settings.json'));
    expect(settings.instance).toEqual([]);
  });

  it('keeps every planted secret out of the archive, except inside the files the owner uploaded', async () => {
    const zipBytes = await exportZip('alice', { uploads: true, admin: true });
    const entries = readZipEntries(zipBytes);
    for (const entry of entries.filter(item => !item.name.startsWith('files/'))) {
      for (const secret of [
        PROVIDER_API_KEY,
        CONNECTOR_HEADER_SECRET,
        OAUTH_ACCESS_TOKEN,
        PASTED_GITHUB_TOKEN,
        CONNECTOR_PATH_TOKEN,
        CONNECTOR_QUERY_SECRET,
      ]) {
        expect(entry.data.includes(Buffer.from(secret))).toBe(false);
      }
    }
    // The scrubbed content itself still ships, around the redactions.
    const chats = zipEntryText(entries, 'chats.json');
    expect(chats).toContain('please use it');
    expect(chats).toContain('[redacted]');
    expect(chats).toContain('Also saw this token');
  });

  it('exports connectors without credentials, query strings or token path segments', async () => {
    const entries = readZipEntries(await exportZip('alice'));
    const connectors = z
      .array(z.object({ name: z.string(), manifest: z.object({ url: z.string() }).passthrough() }))
      .parse(zipEntryJson(entries, 'connectors.json'));
    const planted = connectors.find(connector => connector.name === 'planted-connector');
    expect(planted?.manifest).not.toHaveProperty('auth');
    expect(planted?.manifest.url).toBe('https://connector.example.com/mcp/[redacted]/v1');
  });

  it('exports model provider setups without their keys', async () => {
    const entries = readZipEntries(await exportZip('alice'));
    const providers = z
      .array(z.object({ name: z.string(), manifest: z.object({ type: z.string() }).passthrough() }))
      .parse(zipEntryJson(entries, 'model_providers.json'));
    const planted = providers.find(provider => provider.name === 'planted-provider');
    expect(planted?.manifest).not.toHaveProperty('auth');
    expect(planted?.manifest).toMatchObject({
      type: 'custom',
      base_url: 'https://provider.example.com/v1',
      models: [{ model_id: 'planted-model', name: 'planted-model' }],
    });
  });

  it('leaves out deployment-bound session fields', async () => {
    const zipBytes = await exportZip('alice');
    for (const marker of ['sandbox-handle-should-not-ship', AUTH_URL, 'sandbox.created', 'sandbox_info']) {
      expect(zipBytes.includes(Buffer.from(marker))).toBe(false);
    }
    const [entry] = z.array(SessionEntrySchema).parse(legacySessionsOf(readZipEntries(zipBytes)));
    expect(entry?.turns[0]?.events.map(event => event.type)).toContain('mcp.auth_required');
    expect(entry?.turns[0]?.events.map(event => event.type)).not.toContain('sandbox.created');
    expect(zipBytes.includes(Buffer.from(APPROVAL_TOKEN_ID))).toBe(false);
  });

  it("never includes another user's data, including agent-bound sessions and schedules", async () => {
    const zipBytes = await exportZip('alice', { admin: true });
    for (const marker of [
      'bob-session-1',
      'bob private question',
      'bob-on-alice-agent',
      'bob asks the shared agent',
      'Bob Persona',
      'bob-weekly',
      'Bob weekly task',
      'Bob private memory',
    ]) {
      expect(zipBytes.includes(Buffer.from(marker))).toBe(false);
    }
    const bobEntries = readZipEntries(await exportZip('bob'));
    const bobSessions = z.array(SessionEntrySchema).parse(legacySessionsOf(bobEntries));
    expect(bobSessions.map(entry => entry.session.session_id).sort()).toEqual(['bob-on-alice-agent', 'bob-session-1']);
    expect(zipEntryText(bobEntries, 'agents.json')).toContain('bob-agent');
    expect(zipEntryText(bobEntries, 'agents.json')).not.toContain('reporter');
    const bobMemory = bobEntries.map(entry => entry.name).filter(name => name.startsWith('memory/'));
    expect(bobMemory.every(name => name.startsWith(`memory/${BOB_VAULT}/`))).toBe(true);
  });

  it('includes uploaded files only when requested, byte-exact, under normalized names the index records', async () => {
    const withUploads = readZipEntries(await exportZip('alice', { uploads: true }));
    const names = withUploads.map(entry => entry.name);
    const turnDir = 'files/alice-session-1/alice-session-1-turn-1';
    expect(names).toContain(`${turnDir}/notes.txt`);
    expect(names).toContain(`${turnDir}/blob.bin`);
    expect(names).toContain(`${turnDir}/escape.txt`);
    expect(names.every(name => !name.includes('..') && !name.includes('\\') && !name.startsWith('/'))).toBe(true);
    // The owner's own file ships as uploaded; the export never rewrites its bytes.
    expect(zipEntryText(withUploads, `${turnDir}/notes.txt`)).toBe(`remember the token ${OAUTH_ACCESS_TOKEN}`);
    const blob = withUploads.find(entry => entry.name === `${turnDir}/blob.bin`);
    expect(blob?.data.equals(Buffer.from([0x00, 0x9f, 0xff, 0x10, 0x42]))).toBe(true);
    const [entry] = z
      .array(z.object({ artifacts: z.array(z.object({ path: z.string(), archive_entry: z.string() })) }))
      .parse(legacySessionsOf(withUploads));
    expect(
      Object.fromEntries((entry?.artifacts ?? []).map(artifact => [artifact.path, artifact.archive_entry])),
    ).toEqual({
      'notes.txt': `${turnDir}/notes.txt`,
      'blob.bin': `${turnDir}/blob.bin`,
      '..\\..\\C:\\escape.txt': `${turnDir}/escape.txt`,
    });
  });

  it('fails the download, not just truncates it, when the size cap is hit', async () => {
    configuration.DATA_EXPORT_MAX_BYTES = 512;
    try {
      const response = await requestExport('alice');
      // The archive cannot be completed, so reading the body must fail.
      await expect(response.arrayBuffer()).rejects.toThrow();
    } finally {
      configuration.DATA_EXPORT_MAX_BYTES = originalConfig.DATA_EXPORT_MAX_BYTES;
    }
    expect((await auditDescriptions('alice')).some(text => text === 'Data export failed (over the size limit).')).toBe(
      true,
    );
  });

  it('stops producing when the client goes away', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 0x61);
    await new SqliteTurnArtifactStore(server.db()).recordStoredArtifact({
      tenant_id: TENANT_ID,
      session_id: 'bob-session-1',
      turn_id: 'bob-session-1-turn-1',
      path: 'big.bin',
      name: 'big.bin',
      data: Buffer.concat([big, Buffer.from([0xff])]),
      mime: 'application/octet-stream',
    });
    const response = await requestExport('bob', { uploads: true });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    await reader?.cancel();
    const deadline = Date.now() + 10_000;
    let cancelledRecorded = false;
    while (!cancelledRecorded && Date.now() < deadline) {
      cancelledRecorded = (await auditDescriptions('bob')).includes('Data export failed (the download was cancelled).');
      if (!cancelledRecorded) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    expect(cancelledRecorded).toBe(true);
  });

  it('records one audit row per completed export, without content', async () => {
    await exportZip('alice');
    const descriptions = await auditDescriptions('alice');
    expect(descriptions.some(text => text.startsWith('Exported their data'))).toBe(true);
    expect(descriptions.join('\n')).not.toContain('tide pools');
  });
});
