/**
 * The Tour card "Show what it costs" over the real server path: a scripted model calls the usage
 * tool with the card's prompt, and the finished turn carries the figures from the person's own chats.
 */
import { z } from '@hono/zod-openapi';
import { type Turn, type TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { TurnStreamingEventSchema } from '../../../src/schemas/events';
import { GetTurnResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { QUOTE_TOOL_RESULT_DIRECTIVE, RUN_DIRECTIVE_PREFIX } from '../../fixtures/scriptedModelServer';
import { seedDoneChat, usageEvent } from '../../fixtures/usageEvents';

const TENANT_ID = 'default';
const CARD_PROMPT = 'Show me what my chats have cost so far this month.';
const OTHER_PERSON = 'someone-else';
const TURN_TIMEOUT_MS = 60_000;

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Answer questions about the person’s own usage.',
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
};

function jsonInit(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function createSession(server: ApprovalTestServer): Promise<string> {
  const response = await server.request('/api/v1/sessions', jsonInit({ agent: { spec: AGENT_SPEC } }));
  const body: unknown = await response.json();
  if (response.status !== 201) {
    throw new Error(`session create failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return z.object({ data: z.object({ id: z.string() }).loose() }).parse(body).data.id;
}

async function runTurn({
  server,
  sessionId,
  input,
}: {
  server: ApprovalTestServer;
  sessionId: string;
  input: TurnInputItem[];
}): Promise<Turn> {
  const response = await server.request(`/api/v1/sessions/${sessionId}/turns`, jsonInit({ input, stream: true }));
  if (response.status !== 200) {
    throw new Error(`create turn failed (${String(response.status)}): ${JSON.stringify(await response.json())}`);
  }
  let turnId: string | undefined;
  for (const line of (await response.text()).split('\n')) {
    if (line.startsWith('data: ')) {
      const event = TurnStreamingEventSchema.parse(JSON.parse(line.slice('data: '.length)));
      if (event.type === 'turn.created') {
        turnId = event.turn_id;
      }
    }
  }
  if (turnId === undefined) {
    throw new Error('turn stream carried no turn.created event');
  }
  const turn = await server.request(`/api/v1/sessions/${sessionId}/turns/${turnId}`);
  return GetTurnResponseSchema.parse(await turn.json()).data;
}

describe('usage summary over the turn path', () => {
  let server: ApprovalTestServer;

  beforeEach(async () => {
    server = await startApprovalTestServer();
  }, 120_000);

  afterEach(async () => {
    await server.close();
  });

  it(
    'answers the Tour cost question from the person’s own usage',
    async () => {
      const sessionId = await createSession(server);
      const store = server.sessionStore();
      const owner = (await store.getSession({ tenant_id: TENANT_ID, session_id: sessionId }))?.created_by_subject
        .subject_id;
      if (owner === undefined) {
        throw new Error('the new session has no creator');
      }
      const now = new Date(Date.now() - 60_000).toISOString();
      await seedDoneChat({
        store,
        tenantId: TENANT_ID,
        sessionId: 'seed-trip',
        owner,
        title: 'Trip plan',
        events: [
          usageEvent({
            createdAt: now,
            modelId: 'nvidia/nemotron-3-super-120b-a12b',
            displayName: 'Nemotron 3 Super',
            inputTokens: 1000,
            outputTokens: 500,
            costUsd: 0.00075,
          }),
        ],
      });
      await seedDoneChat({
        store,
        tenantId: TENANT_ID,
        sessionId: 'seed-private-model',
        owner,
        title: null,
        events: [
          usageEvent({
            createdAt: now,
            modelId: 'acme/private-model',
            displayName: 'private-model',
            inputTokens: 300,
            outputTokens: 100,
            costUsd: null,
          }),
        ],
      });
      await seedDoneChat({
        store,
        tenantId: TENANT_ID,
        sessionId: 'seed-other-person',
        owner: OTHER_PERSON,
        title: 'Their private plan',
        events: [
          usageEvent({
            createdAt: now,
            modelId: 'nvidia/nemotron-3-super-120b-a12b',
            displayName: 'Nemotron 3 Super',
            inputTokens: 900_000,
            outputTokens: 100_000,
            costUsd: 0.36,
          }),
        ],
      });

      const turn = await runTurn({
        server,
        sessionId,
        input: [
          {
            type: 'user.message',
            content: `${CARD_PROMPT} ${RUN_DIRECTIVE_PREFIX}usage_summary ${QUOTE_TOOL_RESULT_DIRECTIVE}`,
          },
        ],
      });

      expect(turn.state.status).toBe('done');
      const answer = JSON.stringify(turn.state);
      const advertised = server.model
        .requests()
        .some(request => request.tools.some(tool => tool.function?.name === 'usage_summary'));
      expect(advertised).toBe(true);
      expect(answer).toContain('1900');
      expect(answer).toContain('Trip plan');
      expect(answer).not.toContain('Their private plan');
      expect(answer).not.toContain('1000000');
    },
    TURN_TIMEOUT_MS,
  );
});
