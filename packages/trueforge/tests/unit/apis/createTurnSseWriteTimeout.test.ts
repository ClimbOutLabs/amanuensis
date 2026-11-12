/**
 * A client that stops reading a streamed reply: the write to it times out, the response ends at
 * once so the client can reconnect, and the reply keeps running on the server.
 */
import { z } from '@hono/zod-openapi';
import configuration from '../../../src/config';
import { ListTurnsResponseSchema } from '../../../src/schemas/turn';
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

async function onlyTurnStatus(server: ApprovalTestServer, sessionId: string): Promise<string | undefined> {
  const body: unknown = await (await server.request(`/api/v1/sessions/${sessionId}/turns`)).json();
  return ListTurnsResponseSchema.parse(body).data[0]?.state.status;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('a streamed reply whose client stops reading', () => {
  let server: ApprovalTestServer;
  const original = configuration.TURN_SSE_STREAM_WRITE_TIMEOUT_MS;

  beforeAll(async () => {
    server = await startApprovalTestServer();
    configuration.TURN_SSE_STREAM_WRITE_TIMEOUT_MS = 200;
  });

  afterAll(async () => {
    configuration.TURN_SSE_STREAM_WRITE_TIMEOUT_MS = original;
    await server.close();
  });

  it('ends the response when a write times out, while the reply keeps running', async () => {
    const sessionId = await createSession(server);
    const before = server.model.requests().length;
    const response = await server.request(
      `/api/v1/sessions/${sessionId}/turns`,
      post({
        input: [{ type: 'user.message', content: `${RUN_DIRECTIVE_PREFIX}${STALL_AT_ONCE_DIRECTIVE}` }],
        stream: true,
      }),
    );
    expect(response.status).toBe(200);

    // Nothing reads the body, so the writes back up until one times out.
    const deadline = Date.now() + 10_000;
    while (server.model.requests().length === before) {
      if (Date.now() > deadline) throw new Error('the model was never asked');
      await sleep(20);
    }
    await sleep(1_000);

    // Reading now drains what was buffered. The response must already be over, not held open
    // until the reply finishes (it never does on its own: the model went quiet).
    const outcome = await Promise.race([
      response.text().then(
        () => 'ended',
        () => 'ended',
      ),
      sleep(5_000).then(() => 'still open'),
    ]);
    expect(outcome).toBe('ended');
    expect(await onlyTurnStatus(server, sessionId)).toBe('running');

    const cancel = await server.request(`/api/v1/sessions/${sessionId}/cancel`, post({}));
    expect(cancel.status).toBe(200);
  }, 30_000);
});
