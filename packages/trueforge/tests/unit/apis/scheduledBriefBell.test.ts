/** A scheduled morning brief that finishes leaves one quiet line in the bell, linked to the brief's chat. */
import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import { DeliveryStore } from '../../../src/db/deliveryStore';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { SqliteScheduleStore } from '../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { BRIEF_READY_FALLBACK_TEXT } from '../../../src/runtime/briefDelivery';
import type { Delivery } from '../../../src/schemas/deliveries';
import { ScheduleManifestSchema } from '../../../src/schemas/schedule';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';

const TURN_TIMEOUT_MS = 60_000;
const BELL_WAIT_MS = 15_000;

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
const OWNER = { tenant_id: 'default', created_by: OWNER_SUBJECT.subject_id };

/** The bell line lands after the run's stream ends, so this waits a while for it. */
async function bellItems(server: ApprovalTestServer): Promise<Delivery[]> {
  const store = new DeliveryStore(server.db());
  const deadline = Date.now() + BELL_WAIT_MS;
  for (;;) {
    const { deliveries } = await store.list({ ...OWNER, limit: 10 });
    if (deliveries.length > 0 || Date.now() > deadline) {
      return deliveries;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe('a scheduled brief in the bell', () => {
  let server: ApprovalTestServer;
  let memoryDir = '';
  const original = {
    MEMORY_MARKDOWN_DIR: configuration.MEMORY_MARKDOWN_DIR,
    MEMORY_EMBEDDINGS_ENABLED: configuration.MEMORY_EMBEDDINGS_ENABLED,
  };

  beforeAll(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), 'scheduled-brief-bell-'));
    Object.assign(configuration, { MEMORY_MARKDOWN_DIR: memoryDir, MEMORY_EMBEDDINGS_ENABLED: false });
    server = await startApprovalTestServer();
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
    Object.assign(configuration, original);
    await rm(memoryDir, { recursive: true, force: true });
  }, TURN_TIMEOUT_MS);

  it(
    'puts one note in the bell, linked to the chat the brief ran in',
    async () => {
      const agent = await new SqliteAgentStore(server.db()).createAgent({
        host_managed: false,
        tenant_id: 'default',
        created_by_subject: OWNER_SUBJECT,
        name: 'brief-bell-run',
        description: 'Scheduled agent used by the brief bell test.',
        manifest: AGENT_SPEC,
        external_id: 'brief-bell-run-external-id',
      });
      const scheduled = await new SqliteScheduleStore(server.db()).createScheduleAndRun({
        tenant_id: 'default',
        agent_id: agent.id,
        agent_name: agent.name,
        persona_id: null,
        name: 'morning-brief',
        manifest: ScheduleManifestSchema.parse({
          task: 'Say good morning.',
          cron: '0 7 * * *',
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

      const items = await bellItems(server);
      expect(items).toEqual([
        expect.objectContaining({
          kind: 'note',
          level: 'note',
          text: BRIEF_READY_FALLBACK_TEXT,
          link: { type: 'chat', session_id: session.session_id },
        }),
      ]);
      expect(items[0]?.attempts.map(attempt => attempt.channel)).toEqual(['in_app']);
    },
    TURN_TIMEOUT_MS,
  );
});
