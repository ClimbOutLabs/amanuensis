/**
 * Both ways a turn starts, a chat turn and a scheduled run, leave the chat stamped with its latest answer,
 * so the chat list can show the unseen-answer dot whichever way the answer arrived.
 */
import { z } from '@hono/zod-openapi';
import { AgentSpecSchema, LATEST_ANSWER_AT_METADATA_KEY } from '@truefoundry/trueforge-core/agent-session';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { SqliteScheduleStore } from '../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { ScheduleManifestSchema } from '../../../src/schemas/schedule';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';

const TURN_TIMEOUT_MS = 60_000;
const STAMP_WAIT_MS = 15_000;

const AGENT_SPEC = AgentSpecSchema.parse({
  model: { name: MODEL_FQN },
  instructions: 'Answer the user.',
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
});

const OWNER_SUBJECT = {
  subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
  subject_type: 'user' as const,
  subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
};

function jsonInit(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** The chat's answer stamp; it lands after the turn's stream ends, so this waits a while for it. */
async function answerStamp({ server, sessionId }: { server: ApprovalTestServer; sessionId: string }) {
  const deadline = Date.now() + STAMP_WAIT_MS;
  for (;;) {
    const record = await server.sessionStore().getSession({ tenant_id: 'default', session_id: sessionId });
    const stamp = record?.metadata[LATEST_ANSWER_AT_METADATA_KEY];
    if (stamp !== undefined || Date.now() > deadline) {
      return stamp;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe('the answer stamp, through each way a turn starts', () => {
  let server: ApprovalTestServer;
  let memoryDir = '';
  const original = {
    MEMORY_BACKEND: configuration.MEMORY_BACKEND,
    MEMORY_MARKDOWN_DIR: configuration.MEMORY_MARKDOWN_DIR,
    MEMORY_EMBEDDINGS_ENABLED: configuration.MEMORY_EMBEDDINGS_ENABLED,
  };

  beforeAll(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), 'turn-answer-mark-'));
    Object.assign(configuration, {
      MEMORY_BACKEND: 'markdown',
      MEMORY_MARKDOWN_DIR: memoryDir,
      MEMORY_EMBEDDINGS_ENABLED: false,
    });
    server = await startApprovalTestServer();
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
    Object.assign(configuration, original);
    await rm(memoryDir, { recursive: true, force: true });
  }, TURN_TIMEOUT_MS);

  it(
    'stamps a chat after a turn the person sends finishes with an answer',
    async () => {
      const created = await server.request('/api/v1/sessions', jsonInit({ agent: { spec: AGENT_SPEC } }));
      const sessionId = z.object({ data: z.object({ id: z.string() }).loose() }).parse(await created.json()).data.id;
      const response = await server.request(
        `/api/v1/sessions/${sessionId}/turns`,
        jsonInit({ input: [{ type: 'user.message', content: 'Hello there.' }], stream: true }),
      );
      expect(response.status).toBe(200);
      await response.text();

      expect(await answerStamp({ server, sessionId })).toEqual(expect.any(String));
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'stamps the chat a scheduled run writes its answer into',
    async () => {
      const agent = await new SqliteAgentStore(server.db()).createAgent({
        host_managed: false,
        tenant_id: 'default',
        created_by_subject: OWNER_SUBJECT,
        name: 'answer-mark-run',
        description: 'Scheduled agent used by the answer stamp test.',
        manifest: AGENT_SPEC,
        external_id: 'answer-mark-run-external-id',
      });
      const scheduled = await new SqliteScheduleStore(server.db()).createScheduleAndRun({
        tenant_id: 'default',
        agent_id: agent.id,
        agent_name: agent.name,
        persona_id: null,
        name: 'Morning note',
        manifest: ScheduleManifestSchema.parse({
          task: 'Say good morning.',
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
      const execute = await server.request('/api/internal/schedules/runs/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${configuration.TRUEFORGE_API_KEY}` },
        body: JSON.stringify({ schedule_run_id: run.id }),
      });
      expect(execute.status).toBe(204);
      const session = await server.sessionStore().getSessionByExternalId({ tenant_id: 'default', external_id: run.id });
      if (session === undefined) {
        throw new Error('the scheduled run created no chat');
      }

      expect(await answerStamp({ server, sessionId: session.session_id })).toEqual(expect.any(String));
    },
    TURN_TIMEOUT_MS,
  );
});
