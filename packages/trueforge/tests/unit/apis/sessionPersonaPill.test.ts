/**
 * The session persona pill must switch the persona answering the next turn.
 * Drives the pill's exact PUT/GET flow over real HTTP against the real
 * server, judged by what the scripted model endpoint saw (the same evidence
 * personaFlow.test.ts uses). Also covers pill/chat switching interplay.
 */
import { z } from '@hono/zod-openapi';
import { TurnStreamingEventSchema } from '../../../src/schemas/events';
import {
  ALT_MODEL_FQN,
  MODEL_FQN,
  startApprovalTestServer,
} from '../../fixtures/approvalTestServer';

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

function jsonInit(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function createSession(server: Awaited<ReturnType<typeof startApprovalTestServer>>): Promise<string> {
  const response = await server.request('/api/v1/sessions', jsonInit({ agent: { spec: AGENT_SPEC } }));
  const body: unknown = await response.json();
  if (response.status !== 201) {
    throw new Error(`session create failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return z.object({ data: z.object({ id: z.string() }).loose() }).parse(body).data.id;
}

async function createPersona(
  server: Awaited<ReturnType<typeof startApprovalTestServer>>,
  persona: { display_name: string; aliases: string[]; instructions: string; model_name: string },
): Promise<string> {
  const response = await server.request('/api/v1/personas', jsonInit({ persona }));
  const body: unknown = await response.json();
  if (response.status !== 201) {
    throw new Error(`persona create failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return z.object({ data: z.object({ id: z.string() }).loose() }).parse(body).data.id;
}

/** Exactly what the pill's setSessionPersona does: PUT { persona_id }. */
async function pillSetPersona(options: {
  server: Awaited<ReturnType<typeof startApprovalTestServer>>;
  sessionId: string;
  personaId: string | null;
}) {
  const response = await options.server.request(
    `/api/v1/sessions/${options.sessionId}/persona`,
    jsonInit({ persona_id: options.personaId }, 'PUT'),
  );
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, body };
}

/** Exactly what the pill re-reads after the mutation settles. */
async function pillGetPersona(options: {
  server: Awaited<ReturnType<typeof startApprovalTestServer>>;
  sessionId: string;
}) {
  const response = await options.server.request(`/api/v1/sessions/${options.sessionId}/persona`);
  const body: unknown = await response.json();
  const data = z
    .object({
      data: z.object({ persona_id: z.string().nullable(), source: z.string() }).loose().nullable(),
    })
    .parse(body).data;
  return { status: response.status, data };
}

async function runTurn(options: {
  server: Awaited<ReturnType<typeof startApprovalTestServer>>;
  sessionId: string;
  content: string;
}): Promise<string> {
  const response = await options.server.request(
    `/api/v1/sessions/${options.sessionId}/turns`,
    jsonInit({ input: [{ type: 'user.message', content: options.content }], stream: true }),
  );
  if (response.status !== 200) {
    const body: unknown = await response.json();
    throw new Error(`create turn failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  const streamBody = await response.text();
  for (const line of streamBody.split('\n')) {
    if (!line.startsWith('data: ')) {
      continue;
    }
    const event = TurnStreamingEventSchema.parse(JSON.parse(line.slice('data: '.length)));
    if (event.type === 'turn.created') {
      return event.turn_id;
    }
  }
  throw new Error(`turn stream carried no turn.created event: ${streamBody.slice(0, 400)}`);
}

function lastCompletion(server: Awaited<ReturnType<typeof startApprovalTestServer>>) {
  const requests = server.model.requests();
  const latest = requests[requests.length - 1];
  if (latest === undefined) {
    throw new Error('the scripted model endpoint was never called');
  }
  const system = latest.messages
    .filter(message => message.role === 'system')
    .map(message => (typeof message.content === 'string' ? message.content : ''))
    .join('\n');
  return { model: latest.model, system };
}

async function disableTurnSummarization(server: Awaited<ReturnType<typeof startApprovalTestServer>>): Promise<void> {
  const response = await server.request('/api/v1/settings/memory-summarize', jsonInit({ enabled: false }, 'PUT'));
  if (response.status !== 200) {
    throw new Error(`disabling turn summarization failed (${String(response.status)}): ${await response.text()}`);
  }
}

describe('CAR D repro: pill switch A -> B', () => {
  let server: Awaited<ReturnType<typeof startApprovalTestServer>>;

  beforeAll(async () => {
    server = await startApprovalTestServer();
    await disableTurnSummarization(server);
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  }, TURN_TIMEOUT_MS);

  it(
    'the next turn after a pill click answers as the picked persona',
    async () => {
      const sessionId = await createSession(server);
      await createPersona(server, {
        display_name: 'Squidward',
        aliases: [],
        instructions: 'You are Squidward Tentacles. You are grumpy and sarcastic.',
        model_name: ALT_MODEL_FQN,
      });
      const spongebobId = await createPersona(server, {
        display_name: 'Spongebob',
        aliases: [],
        instructions: 'You are Spongebob Squarepants. You are cheerful and earnest.',
        model_name: MODEL_FQN,
      });

      // Baseline: chat establishes Squidward as the old persona.
      await runTurn({ server, sessionId, content: 'Squidward, are you there?' });
      const before = lastCompletion(server);
      expect(before.model).toBe('scripted-alt-model');
      expect(before.system).toContain('<persona-name>Squidward</persona-name>');

      // The pill click.
      const put = await pillSetPersona({ server, sessionId, personaId: spongebobId });
      expect(put.status).toBe(200);

      // The pill re-lookup after the mutation settles.
      const get = await pillGetPersona({ server, sessionId });
      expect(get.status).toBe(200);
      expect(get.data).toMatchObject({ persona_id: spongebobId, source: 'explicit' });

      // The next turn: who answers?
      await runTurn({ server, sessionId, content: 'tell me about your day' });
      const after = lastCompletion(server);
      expect(after.system).toContain('<persona-name>Spongebob</persona-name>');
      expect(after.system).not.toContain('<persona-name>Squidward</persona-name>');
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'pill and chat switching stay consistent (CAR D + #319 interplay)',
    async () => {
      const sessionId = await createSession(server);
      await createPersona(server, {
        display_name: 'SquidwardB',
        aliases: [],
        instructions: 'You are SquidwardB Tentacles. You are grumpy and sarcastic.',
        model_name: ALT_MODEL_FQN,
      });
      const spongebobId = await createPersona(server, {
        display_name: 'SpongebobB',
        aliases: [],
        instructions: 'You are SpongebobB Squarepants. You are cheerful and earnest.',
        model_name: MODEL_FQN,
      });

      // Baseline: chat establishes Squidward.
      await runTurn({ server, sessionId, content: 'SquidwardB, are you there?' });
      expect(lastCompletion(server).system).toContain('<persona-name>SquidwardB</persona-name>');

      // 1. pill A -> B.
      expect((await pillSetPersona({ server, sessionId, personaId: spongebobId })).status).toBe(200);

      // 2. next neutral message stays B.
      await runTurn({ server, sessionId, content: 'tell me about your day' });
      const neutralStaysB = lastCompletion(server);
      expect(neutralStaysB.system).toContain('<persona-name>SpongebobB</persona-name>');
      expect(neutralStaysB.system).not.toContain('<persona-name>SquidwardB</persona-name>');

      // 3. deterministic chat switch B -> A works.
      await runTurn({ server, sessionId, content: 'SquidwardB, take it from here' });
      const chatSwitch = lastCompletion(server);
      expect(chatSwitch.system).toContain('<persona-name>SquidwardB</persona-name>');
      expect(chatSwitch.system).not.toContain('<persona-name>SpongebobB</persona-name>');

      // 4. a later pill switch back to B overrides the chat-selected turn snapshot.
      expect((await pillSetPersona({ server, sessionId, personaId: spongebobId })).status).toBe(200);
      const pillGet = await pillGetPersona({ server, sessionId });
      expect(pillGet.data).toMatchObject({ persona_id: spongebobId, source: 'explicit' });

      // 5. next neutral message stays B.
      await runTurn({ server, sessionId, content: 'what is the plan for today' });
      const final = lastCompletion(server);
      expect(final.system).toContain('<persona-name>SpongebobB</persona-name>');
      expect(final.system).not.toContain('<persona-name>SquidwardB</persona-name>');
    },
    TURN_TIMEOUT_MS,
  );
});
