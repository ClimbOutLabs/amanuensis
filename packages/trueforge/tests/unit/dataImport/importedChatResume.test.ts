/**
 * An imported chat resumed over HTTP: a real export from one server, the admin import route on a
 * fresh one, then new turns, counting the inert connector's write calls.
 */
import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import { HTTPException } from 'hono/http-exception';
import type { Transaction } from 'kysely';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import type { Authenticator } from '../../../src/auth/authenticator';
import type { RequestContext } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import { ZipStreamWriter } from '../../../src/dataExport/zipStreamWriter';
import { SentinelAuditStore } from '../../../src/db/sentinelAuditStore';
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
import { TurnStreamingEventSchema } from '../../../src/schemas/events';
import { GetTurnResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { CollectingWritable, exportInstanceArchive } from '../../fixtures/dataTransferExport';
import type { DataTransferSeedStores } from '../../fixtures/dataTransferSeed';
import { INERT_SERVER_NAME, INERT_WRITE_TOOL } from '../../fixtures/inertMcpServer';
import { listAt, parseJson, recordAt, type JsonRecord } from '../../fixtures/jsonGuards';
import { readZipEntries } from '../../fixtures/zipReader';

jest.setTimeout(240_000);

const TENANT_ID = 'default';

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

const AGENT_SPEC = AgentSpecSchema.parse({
  model: { name: MODEL_FQN },
  instructions: 'Use the inert connector exactly as instructed.',
  mcp_servers: [
    { name: INERT_SERVER_NAME, preload: true, require_approval_for_tools: ['@write', '@destructive', '@unclassified'] },
  ],
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
});

const CreatedSessionSchema = z.object({ data: z.object({ id: z.string() }).loose() });
const RequiredActionsStateSchema = z
  .object({
    status: z.literal('done'),
    required_actions: z.array(
      z.object({ type: z.string(), tool_calls: z.array(z.object({ id: z.string() }).loose()) }).loose(),
    ),
  })
  .loose();

function call(
  server: ApprovalTestServer,
  path: string,
  init: { body?: unknown; raw?: Buffer; admin?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'x-test-user': 'bob' };
  if (init.admin === true) {
    headers['x-test-admin'] = 'yes';
  }
  if (init.raw !== undefined) {
    headers['content-type'] = 'application/zip';
    return server.request(path, { method: 'POST', headers, body: init.raw });
  }
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    return server.request(path, { method: 'POST', headers, body: JSON.stringify(init.body) });
  }
  return server.request(path, { method: 'GET', headers });
}

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

interface PausedTurnEdit {
  main: JsonRecord;
  context: unknown[];
  toolCalls: JsonRecord[];
}

/**
 * Rewrites the chat's paused turn into an ordinary finished one whose write call is still open,
 * so nothing outside the context marks it as waiting, then applies `mutate`.
 */
function tamper(archive: Buffer, sessionId: string, mutate: (edit: PausedTurnEdit) => void): Promise<Buffer> {
  return repack(archive, entries => {
    const sessions = listAt(parseJson(entries.get('sessions.json'), 'sessions.json'), 'sessions.json');
    const entry = recordAt(
      sessions.find(item => recordAt(recordAt(item, 'entry')['session'], 'session')['session_id'] === sessionId),
      'paused chat',
    );
    const turnEntry = recordAt(listAt(entry['turns'], 'turns').at(-1), 'turn entry');
    const turn = recordAt(turnEntry['turn'], 'turn');
    turn['state'] = { status: 'done', output: null, required_actions: [], completed_at: '2026-10-16T09:00:01.000Z' };
    turnEntry['events'] = listAt(turnEntry['events'], 'events').filter(
      event => recordAt(event, 'event')['type'] !== 'tool.approval_required',
    );
    const main = recordAt(recordAt(recordAt(turn['snapshot'], 'snapshot')['threads'], 'threads')['main'], 'main');
    const context = listAt(main['context'], 'context');
    const assistant = recordAt(
      [...context].reverse().find(message => recordAt(message, 'message')['role'] === 'assistant'),
      'assistant',
    );
    const toolCalls = listAt(assistant['tool_calls'], 'tool_calls').map(item => recordAt(item, 'call'));
    mutate({ main, context, toolCalls });
    entries.set('sessions.json', Buffer.from(JSON.stringify(sessions)));
  });
}

function turnIdFromStream(streamBody: string): string | undefined {
  for (const line of streamBody.split('\n')) {
    if (!line.startsWith('data: ')) {
      continue;
    }
    const parsed = TurnStreamingEventSchema.safeParse(JSON.parse(line.slice('data: '.length)));
    if (parsed.success && parsed.data.type === 'turn.created') {
      return parsed.data.turn_id;
    }
  }
  return undefined;
}

async function postTurn(
  server: ApprovalTestServer,
  sessionId: string,
  input: unknown[],
): Promise<{ status: number; state: unknown }> {
  const response = await call(server, `/api/v1/sessions/${sessionId}/turns`, { body: { input, stream: true } });
  const body = await response.text();
  const turnId = response.status === 200 ? turnIdFromStream(body) : undefined;
  if (turnId === undefined) {
    return { status: response.status, state: undefined };
  }
  const turnResponse = await call(server, `/api/v1/sessions/${sessionId}/turns/${turnId}`);
  return { status: response.status, state: GetTurnResponseSchema.parse(await turnResponse.json()).data.state };
}

/** The ids of the calls a finished turn stopped to ask the owner about. */
function askedCallIds(state: unknown): string[] {
  const parsed = RequiredActionsStateSchema.safeParse(state);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.required_actions
    .filter(action => action.type === 'tool.approval_required')
    .flatMap(action => action.tool_calls.map(item => item.id));
}

describe('an imported chat never runs a tool without a fresh approval from the owner', () => {
  let source: ApprovalTestServer;
  let scratch: string;
  let baseArchive: Buffer;
  let pausedSessionId: string;
  let pausedCallId: string;
  const original = {
    MEMORY_MARKDOWN_DIR: configuration.MEMORY_MARKDOWN_DIR,
    PERSONA_KNOWLEDGE_DIR: configuration.PERSONA_KNOWLEDGE_DIR,
    DATA_IMPORT_MAX_BYTES: configuration.DATA_IMPORT_MAX_BYTES,
  };
  const targets: ApprovalTestServer[] = [];

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'tfy-import-resume-'));
    const sourceMemory = join(scratch, 'source-memory');
    const sourceKnowledge = join(scratch, 'source-knowledge');
    await mkdir(sourceMemory, { recursive: true });
    configuration.MEMORY_MARKDOWN_DIR = sourceMemory;
    configuration.PERSONA_KNOWLEDGE_DIR = sourceKnowledge;
    source = await startApprovalTestServer({ authenticator: headerAuthenticator });

    const created = await call(source, '/api/v1/sessions', { body: { agent: { spec: AGENT_SPEC } } });
    expect(created.status).toBe(201);
    pausedSessionId = CreatedSessionSchema.parse(await created.json()).data.id;
    const paused = await postTurn(source, pausedSessionId, [
      { type: 'user.message', content: `run:${INERT_WRITE_TOOL} please` },
    ]);
    pausedCallId = askedCallIds(paused.state)[0] ?? '';
    expect(pausedCallId).not.toBe('');
    expect(source.mcp.writeInvocations()).toBe(0);

    const db = source.db();
    const stores: DataTransferSeedStores<Transaction<Database>> = {
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
    };
    baseArchive = await exportInstanceArchive({
      instance: { stores, memoryDir: sourceMemory, knowledgeDir: sourceKnowledge },
      tenantId: TENANT_ID,
      subjectId: 'bob',
    });
    configuration.DATA_IMPORT_MAX_BYTES = 64 * 1024 * 1024;
  });

  afterAll(async () => {
    for (const target of targets) {
      await target.close();
    }
    await source.close();
    configuration.MEMORY_MARKDOWN_DIR = original.MEMORY_MARKDOWN_DIR;
    configuration.PERSONA_KNOWLEDGE_DIR = original.PERSONA_KNOWLEDGE_DIR;
    configuration.DATA_IMPORT_MAX_BYTES = original.DATA_IMPORT_MAX_BYTES;
    await rm(scratch, { recursive: true, force: true });
  });

  /** A fresh target, imported by the admin route, with the connector attached to the chat again as the owner would. */
  async function importIntoFreshTarget(archive: Buffer, label: string): Promise<ApprovalTestServer> {
    const dir = join(scratch, label);
    await mkdir(join(dir, 'memory'), { recursive: true });
    configuration.MEMORY_MARKDOWN_DIR = join(dir, 'memory');
    configuration.PERSONA_KNOWLEDGE_DIR = join(dir, 'knowledge');
    const target = await startApprovalTestServer({ authenticator: headerAuthenticator });
    targets.push(target);
    const mcp = new SqliteMcpServerStore(target.db());
    for (const server of await mcp.listServers({ tenant_id: TENANT_ID, names: undefined })) {
      await mcp.deleteServer({ tenant_id: TENANT_ID, name: server.name });
    }
    const response = await call(target, '/api/v1/data/import', { raw: archive, admin: true });
    expect(response.status).toBe(200);
    await target.sessionStore().updateSession({
      tenant_id: TENANT_ID,
      session_id: pausedSessionId,
      agent: { type: 'inline', spec: AGENT_SPEC },
      title: undefined,
      metadata: undefined,
    });
    source.mcp.resetInvocations();
    return target;
  }

  function writes(target: ApprovalTestServer): number {
    return source.mcp.writeInvocations() + target.mcp.writeInvocations();
  }

  /** The model repeats the archived call id; the host gives the new write its own id, so no archived decision can address it. */
  function expectAskedUnderNewId(state: unknown): void {
    const asked = askedCallIds(state);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^call_/);
    expect(asked).not.toContain(pausedCallId);
  }

  it('asks again for a new write in an imported chat that repeats the archived call id', async () => {
    const target = await importIntoFreshTarget(baseArchive, 'control');
    const fresh = await postTurn(target, pausedSessionId, [
      { type: 'user.message', content: `run:${INERT_WRITE_TOOL} please` },
    ]);
    expectAskedUnderNewId(fresh.state);
    expect(writes(target)).toBe(0);
  });

  it.each(['once', 'chat', 'always'] as const)(
    'asks again for a new write that reuses the id of an archived allow (scope %s)',
    async scope => {
      const archive = await tamper(baseArchive, pausedSessionId, ({ context }) => {
        context.push({ type: 'user.tool_approval', tool_call_id: pausedCallId, approval: { status: 'allow', scope } });
      });
      const target = await importIntoFreshTarget(archive, `allow-${scope}`);
      const resume = await postTurn(target, pausedSessionId, [{ type: 'user.message', content: 'hello again' }]);
      expect(resume.status).toBe(200);
      expect(writes(target)).toBe(0);
      const fresh = await postTurn(target, pausedSessionId, [
        { type: 'user.message', content: `run:${INERT_WRITE_TOOL} please` },
      ]);
      expectAskedUnderNewId(fresh.state);
      expect(writes(target)).toBe(0);
    },
  );

  it.each(['is_client_side', 'is_thread_creation'] as const)(
    'takes a new message when an open archived call is marked %s',
    async mark => {
      const archive = await tamper(baseArchive, pausedSessionId, ({ toolCalls }) => {
        recordAt(toolCalls[0]?.['tool_info'], 'tool info')[mark] = true;
      });
      const target = await importIntoFreshTarget(archive, `mark-${mark}`);
      const resume = await postTurn(target, pausedSessionId, [{ type: 'user.message', content: 'hello again' }]);
      expect(resume.status).toBe(200);
      expect(resume.state).toMatchObject({ status: 'done' });
      expect(writes(target)).toBe(0);
    },
  );

  it('continues a chat whose archive carried an empty tool-call memo and planted capability state', async () => {
    const archive = await tamper(baseArchive, pausedSessionId, ({ main }) => {
      main['tool_call_memo'] = {};
      main['capability_state'] = { planted: { grant: 'all' } };
    });
    const target = await importIntoFreshTarget(archive, 'memo');
    const resume = await postTurn(target, pausedSessionId, [{ type: 'user.message', content: 'hello again' }]);
    expect(resume.status).toBe(200);
    expect(resume.state).toMatchObject({ status: 'done' });
    expect(writes(target)).toBe(0);
  });
});
