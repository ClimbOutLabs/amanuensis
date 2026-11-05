/**
 * A turn created with spoken_reply tells the model its answer will be read aloud. The judge is the
 * scripted model endpoint's request log for that turn.
 */
import { z } from '@hono/zod-openapi';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';

const TURN_TIMEOUT_MS = 60_000;

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Answer the user.',
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
};

function jsonInit(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function createSession(server: ApprovalTestServer): Promise<string> {
  const response = await server.request('/api/v1/sessions', jsonInit({ agent: { spec: AGENT_SPEC } }));
  const body: unknown = await response.json();
  if (response.status !== 201) {
    throw new Error(`session create failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return z.object({ data: z.object({ id: z.string() }).loose() }).parse(body).data.id;
}

/** Runs one streamed turn to the end and returns everything the model received for it. */
async function modelInputFor(server: ApprovalTestServer, spokenReply: boolean | undefined): Promise<string> {
  const sessionId = await createSession(server);
  const before = server.model.requests().length;
  const response = await server.request(
    `/api/v1/sessions/${sessionId}/turns`,
    jsonInit({
      input: [{ type: 'user.message', content: 'Talk to me' }],
      stream: true,
      ...(spokenReply === undefined ? {} : { spoken_reply: spokenReply }),
    }),
  );
  if (response.status !== 200) {
    throw new Error(`create turn failed (${String(response.status)}): ${await response.text()}`);
  }
  await response.text();
  // The turn's own completion carries the per-reply block; helper calls such as memory notes do not.
  const answer = server.model
    .requests()
    .slice(before)
    .map(request => request.messages.map(message => JSON.stringify(message.content)).join('\n'))
    .find(text => text.includes('reply-context'));
  if (answer === undefined) throw new Error('the scripted model never received the turn itself');
  return answer;
}

describe('spoken_reply on a new turn', () => {
  let server: ApprovalTestServer;

  beforeAll(async () => {
    server = await startApprovalTestServer();
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  }, TURN_TIMEOUT_MS);

  it(
    'tells the model a spoken message is answered aloud',
    async () => {
      expect(await modelInputFor(server, true)).toContain('<spoken-reply>');
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'says nothing about speech for a typed message',
    async () => {
      expect(await modelInputFor(server, undefined)).not.toContain('<spoken-reply>');
    },
    TURN_TIMEOUT_MS,
  );
});
