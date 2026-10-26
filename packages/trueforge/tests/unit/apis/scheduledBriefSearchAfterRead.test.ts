/**
 * A scheduled brief over the real server path: no one is watching, so nothing may stop at a card. The
 * scripted model reads the inbox, searches the web, then maps the address the inbox names. A search that names
 * someone from the mail runs too: the person's own mail is theirs to use.
 */
import { z } from '@hono/zod-openapi';
import { AgentSpecSchema, type Turn } from '@truefoundry/trueforge-core/agent-session';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { SqliteGoogleConnectionStore } from '../../../src/db/sqlite/google-connection-store/SqliteGoogleConnectionStore';
import { SqliteScheduleStore } from '../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { ScheduleManifestSchema } from '../../../src/schemas/schedule';
import { GetTurnResponseSchema, ListTurnsResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { HARBOUR_ADDRESS, installRecordedTavily } from '../../fixtures/groundedFinderFixtures';
import { installRecordedMail, MAIL_SENDER_NAME } from '../../fixtures/recordedMail';
import { BRIEF_DIRECTIVE, RUN_DIRECTIVE_PREFIX, SEARCH_DIRECTIVE_PREFIX } from '../../fixtures/scriptedModelServer';

const TURN_TIMEOUT_MS = 60_000;
const TAVILY_SERVER_NAME = 'tavily';
const CLEAN_QUERY = 'Lantern Row bakery';
/** A phrase only the repeat-run test uses, so its schedule name stays unique. */
const REPEAT_QUERY = 'Quay Street florist';
/** Carries the sender's name, which the mail header copies. */
const NAMED_QUERY = `${MAIL_SENDER_NAME} bakery`;

const AGENT_SPEC = AgentSpecSchema.parse({
  model: { name: MODEL_FQN },
  instructions: 'Write the morning brief from the inbox, the web and the map.',
  mcp_servers: [{ name: TAVILY_SERVER_NAME, preload: true }],
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
});

/** The standalone owner, in the wire shape the agent and schedule stores keep. */
const OWNER_SUBJECT = {
  subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
  subject_type: 'user' as const,
  subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
};

const AuditLogResponseSchema = z.object({
  entries: z.array(
    z
      .object({
        tier: z.number(),
        tool_name: z.string(),
        description: z.string(),
        outcome: z.string(),
        auto_deny_reason: z.string().nullable(),
      })
      .loose(),
  ),
});

function jsonInit(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** Creates an active schedule whose task searches for `search`, and returns it with its first pending run. */
async function createBriefSchedule({
  server,
  agent,
  search,
}: {
  server: ApprovalTestServer;
  agent: { id: string; name: string };
  search: string;
}) {
  const scheduled = await new SqliteScheduleStore(server.db()).createScheduleAndRun({
    tenant_id: 'default',
    agent_id: agent.id,
    agent_name: agent.name,
    persona_id: null,
    name: `morning brief: ${search}`,
    manifest: ScheduleManifestSchema.parse({
      task: `Brief me on the morning. ${RUN_DIRECTIVE_PREFIX}${BRIEF_DIRECTIVE} ${SEARCH_DIRECTIVE_PREFIX}${search}`,
      cron: '0 8 * * *',
      timezone: 'UTC',
      status: 'active',
    }),
    created_by_subject: OWNER_SUBJECT,
    runFrom: new Date(),
  });
  const run = scheduled.pendingRun;
  if (run === undefined) {
    throw new Error('the active schedule added no pending run');
  }
  return { schedule: scheduled.schedule, run };
}

/** Executes one persisted run and returns its session id and finished turn. */
async function executeRun({
  server,
  runId,
}: {
  server: ApprovalTestServer;
  runId: string;
}): Promise<{ sessionId: string; turn: Turn }> {
  // The scheduler hands the persisted run to the internal execution endpoint with the service key.
  const execute = await server.request('/api/internal/schedules/runs/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${configuration.TRUEFORGE_API_KEY}` },
    body: JSON.stringify({ schedule_run_id: runId }),
  });
  expect(execute.status).toBe(204);

  const session = await new SqliteSessionStore(server.db()).getSessionByExternalId({
    tenant_id: 'default',
    external_id: runId,
  });
  if (session === undefined) {
    throw new Error('the scheduled run created no session');
  }
  return { sessionId: session.session_id, turn: await finishedTurn(server, session.session_id) };
}

/** Runs one scheduled brief for `search` and returns its session id and finished turn. */
async function runScheduledBrief({
  server,
  agent,
  search,
}: {
  server: ApprovalTestServer;
  agent: { id: string; name: string };
  search: string;
}): Promise<{ sessionId: string; turn: Turn }> {
  const { run } = await createBriefSchedule({ server, agent, search });
  return executeRun({ server, runId: run.id });
}

async function finishedTurn(server: ApprovalTestServer, sessionId: string): Promise<Turn> {
  const list = ListTurnsResponseSchema.parse(
    await (await server.request(`/api/v1/sessions/${sessionId}/turns`)).json(),
  );
  const turnId = list.data[0]?.id;
  if (turnId === undefined) {
    throw new Error('the scheduled run started no turn');
  }
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  for (;;) {
    const turn = GetTurnResponseSchema.parse(
      await (await server.request(`/api/v1/sessions/${sessionId}/turns/${turnId}`)).json(),
    ).data;
    if (turn.state.status !== 'running') {
      return turn;
    }
    if (Date.now() > deadline) {
      throw new Error(`turn ${turnId} never left the running state`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function auditEntries(server: ApprovalTestServer, sessionId: string) {
  const response = await server.request(`/api/v1/sessions/${sessionId}/audit-log`);
  expect(response.status).toBe(200);
  return AuditLogResponseSchema.parse(await response.json()).entries;
}

describe('scheduled brief: search and map after reading the mail', () => {
  let server: ApprovalTestServer;
  let tavily: ReturnType<typeof installRecordedTavily>;
  let mail: ReturnType<typeof installRecordedMail>;
  let agent: { id: string; name: string };
  const originalBackend = configuration.MEMORY_BACKEND;
  const originalDir = configuration.MEMORY_MARKDOWN_DIR;
  const originalEmbeddings = configuration.MEMORY_EMBEDDINGS_ENABLED;
  const originalSummarize = configuration.MEMORY_SUMMARIZE;
  let memoryDir: string;

  beforeAll(async () => {
    // Scheduled runs save to the memory vault, so a later run could recall an earlier one.
    memoryDir = await mkdtemp(join(tmpdir(), 'scheduled-brief-memory-'));
    configuration.MEMORY_BACKEND = 'markdown';
    configuration.MEMORY_MARKDOWN_DIR = memoryDir;
    configuration.MEMORY_EMBEDDINGS_ENABLED = false;
    configuration.MEMORY_SUMMARIZE = false;
    server = await startApprovalTestServer();
    tavily = installRecordedTavily();
    mail = installRecordedMail();
    agent = await new SqliteAgentStore(server.db()).createAgent({
      host_managed: false,
      tenant_id: 'default',
      created_by_subject: OWNER_SUBJECT,
      name: 'morning-brief',
      description: 'Scheduled brief used by the search-after-read tests.',
      manifest: AGENT_SPEC,
      external_id: 'morning-brief-external-id',
    });
    const saved = await server.request(
      '/api/v1/settings/mcp-servers',
      jsonInit(
        {
          manifest: {
            type: 'remote',
            name: TAVILY_SERVER_NAME,
            url: 'https://mcp.tavily.com/mcp',
            description: 'Search the web, extract page content, and crawl sites.',
            search_provider: true,
            auth: { type: 'header', headers: { Authorization: 'Bearer YOUR_TAVILY_API_KEY' } },
          },
        },
        'PUT',
      ),
    );
    expect(saved.status).toBe(200);
    const now = new Date().toISOString();
    await new SqliteGoogleConnectionStore(server.db()).save({
      tenant_id: 'default',
      created_by: STANDALONE_REQUEST_CONTEXT.subject.id,
      client_id: '123456789-abcdefghij.apps.googleusercontent.com',
      client_secret: 'GOCSPX-recorded',
      client_type: 'desktop',
      refresh_token: 'recorded-refresh-token',
      granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      account_email: 'owner@example.com',
      status: 'connected',
      created_at: now,
      updated_at: now,
    });
    // The user lets searches and maps run without asking, as the settings page does.
    const settings = await server.request(
      '/api/v1/user/settings/sentinel',
      jsonInit({ search_without_asking: true, maps_without_asking: true }, 'PATCH'),
    );
    expect(settings.status).toBe(200);
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    mail.restore();
    tavily.restore();
    await server.close();
    configuration.MEMORY_BACKEND = originalBackend;
    configuration.MEMORY_MARKDOWN_DIR = originalDir;
    configuration.MEMORY_EMBEDDINGS_ENABLED = originalEmbeddings;
    configuration.MEMORY_SUMMARIZE = originalSummarize;
    await rm(memoryDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    tavily.calls.length = 0;
    mail.calls.length = 0;
  });

  it(
    'reads the mail, searches with a clean query, and maps the inbox address, with no card left waiting',
    async () => {
      const { sessionId, turn } = await runScheduledBrief({
        agent,
        server,
        search: CLEAN_QUERY,
      });

      expect(turn.state.status).toBe('done');
      expect(turn.state).toMatchObject({ required_actions: [] });
      expect(mail.calls).toContain('/gmail/v1/users/me/threads');
      expect(tavily.calls.map(call => call.path)).toEqual(['/search']);
      expect(tavily.calls[0]?.body).toMatchObject({ query: CLEAN_QUERY });

      const entries = await auditEntries(server, sessionId);
      const search = entries.find(e => e.tool_name === 'tavily_search' && e.description === `Searched: ${CLEAN_QUERY}`);
      const map = entries.find(
        e => e.tool_name === 'render_map' && e.description === `Maps ran without asking: ${HARBOUR_ADDRESS}`,
      );
      expect(search).toMatchObject({ tier: 1, outcome: 'logged' });
      expect(map).toMatchObject({ tier: 1, outcome: 'logged' });
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'runs a search that names the sender of the mail it read, with no card',
    async () => {
      const { turn } = await runScheduledBrief({
        agent,
        server,
        search: NAMED_QUERY,
      });

      expect(turn.state.status).toBe('done');
      expect(turn.state).toMatchObject({ required_actions: [] });
      expect(tavily.calls.map(call => call.path)).toEqual(['/search']);
      expect(tavily.calls[0]?.body).toMatchObject({ query: NAMED_QUERY });
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'runs the same schedule twice and the second run searches the first run’s words, with no card left waiting',
    async () => {
      const { schedule, run: firstRun } = await createBriefSchedule({ server, agent, search: REPEAT_QUERY });
      const first = await executeRun({ server, runId: firstRun.id });
      expect(first.turn.state.status).toBe('done');

      const store = new SqliteScheduleStore(server.db());
      const second = await executeRun({
        server,
        runId: (
          (await store.getScheduledRunFor({ tenant_id: 'default', schedule_id: schedule.id })) ??
          (await store.createRun({
            tenant_id: 'default',
            schedule_id: schedule.id,
            name: schedule.name,
            scheduled_for: new Date(),
            created_by_subject: OWNER_SUBJECT,
            status: 'scheduled',
          }))
        ).id,
      });

      expect(second.turn.state.status).toBe('done');
      expect(second.turn.state).toMatchObject({ required_actions: [] });
      const entries = await auditEntries(server, second.sessionId);
      expect(entries.find(e => e.tool_name === 'tavily_search')).toMatchObject({
        description: `Searched: ${REPEAT_QUERY}`,
        outcome: 'logged',
        auto_deny_reason: null,
      });
    },
    TURN_TIMEOUT_MS * 2,
  );
});
