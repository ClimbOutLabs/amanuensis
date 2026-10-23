/**
 * A reply that was running when the server restarted is ended when the chat comes back to it, and
 * the reason is saved with the turn, so every later load of the chat can say why there is no reply.
 */
import { z } from '@hono/zod-openapi';
import { CancellationReason } from '@truefoundry/trueforge-core/agent-session';
import { ListSessionEventsResponseSchema } from '../../../src/schemas/events';
import { GetTurnResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { RUN_DIRECTIVE_PREFIX, STALL_AT_ONCE_DIRECTIVE } from '../../fixtures/scriptedModelServer';

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Answer as instructed.',
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
};

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function createSession(server: ApprovalTestServer): Promise<string> {
  const response = await server.request('/api/v1/sessions', post({ agent: { spec: AGENT_SPEC } }));
  expect(response.status).toBe(201);
  return z.object({ data: z.object({ id: z.string() }).loose() }).parse(await response.json()).data.id;
}

/** Starts a reply whose model goes quiet mid-answer, and waits until the model is answering. */
async function startStalledReply(server: ApprovalTestServer, sessionId: string): Promise<string> {
  const before = server.model.requests().length;
  const response = await server.request(
    `/api/v1/sessions/${sessionId}/turns`,
    post({
      input: [{ type: 'user.message', content: `${RUN_DIRECTIVE_PREFIX}${STALL_AT_ONCE_DIRECTIVE}` }],
      stream: false,
    }),
  );
  expect(response.status).toBeLessThan(300);
  const turn = GetTurnResponseSchema.parse(await response.json()).data;
  const deadline = Date.now() + 10_000;
  while (server.model.requests().length === before) {
    if (Date.now() > deadline) throw new Error('the model was never asked');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return turn.id;
}

async function turnState(server: ApprovalTestServer, sessionId: string, turnId: string) {
  const response = await server.request(`/api/v1/sessions/${sessionId}/turns/${turnId}`);
  expect(response.status).toBe(200);
  return GetTurnResponseSchema.parse(await response.json()).data.state;
}

async function savedTurnEnd(server: ApprovalTestServer, sessionId: string, turnId: string) {
  const response = await server.request(`/api/v1/sessions/${sessionId}/events?last_turn_id=${turnId}`);
  expect(response.status).toBe(200);
  const items = ListSessionEventsResponseSchema.parse(await response.json()).data;
  return items.flatMap(item => (item.turn_id === turnId && item.event.type === 'turn.done' ? [item.event.state] : []));
}

describe('a reply the server restart stopped', () => {
  let server: ApprovalTestServer;

  beforeAll(async () => {
    server = await startApprovalTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('reloads with the restart saved as the reason it ended', async () => {
    const sessionId = await createSession(server);
    const turnId = await startStalledReply(server, sessionId);

    await server.restart();
    expect(await turnState(server, sessionId, turnId)).toEqual({ status: 'running' });

    // The chat finds the reply's run gone and ends it, as an open page does when it reconnects.
    const cancelled = await server.request(`/api/v1/sessions/${sessionId}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(200);

    // A later load reads what was saved, not what any page saw.
    await server.restart();
    expect(await turnState(server, sessionId, turnId)).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.Abandoned,
    });
    expect(await savedTurnEnd(server, sessionId, turnId)).toEqual([
      expect.objectContaining({ status: 'cancelled', reason: CancellationReason.Abandoned }),
    ]);
  }, 60_000);

  it('keeps a Cancel pressed during a running reply as the person cancelling', async () => {
    const sessionId = await createSession(server);
    const turnId = await startStalledReply(server, sessionId);

    const cancelled = await server.request(`/api/v1/sessions/${sessionId}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(200);

    expect(await turnState(server, sessionId, turnId)).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
    });
  }, 60_000);
});
