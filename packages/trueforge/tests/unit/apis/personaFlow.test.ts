/**
 * Walks persona switching over the HTTP surface with a scripted model endpoint.
 *
 * The judge is the scripted endpoint's request log: it records the model id and
 * the system prompt of every completion, which is the only evidence that says
 * which model actually answered — independent of what any status field claims.
 */
import { z } from '@hono/zod-openapi';
import { SessionHandle, TurnHandle } from '@truefoundry/trueforge-core/agent-session';
import { SqlitePersonaStore } from '../../../src/db/sqlite/persona-store/SqlitePersonaStore';
import { TurnStreamingEventSchema } from '../../../src/schemas/events';
import type { UpdatePersonalizationProfileRequest } from '../../../src/schemas/personalization';
import {
  ALT_MODEL_FQN,
  MODEL_FQN,
  startApprovalTestServer,
  type ApprovalTestServer,
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

async function createSession(server: ApprovalTestServer): Promise<string> {
  const response = await server.request('/api/v1/sessions', jsonInit({ agent: { spec: AGENT_SPEC } }));
  const body: unknown = await response.json();
  if (response.status !== 201) {
    throw new Error(`session create failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return z.object({ data: z.object({ id: z.string() }).loose() }).parse(body).data.id;
}

async function createPersona(
  server: ApprovalTestServer,
  persona: { display_name: string; aliases: string[]; instructions: string; model_name: string },
): Promise<string> {
  const response = await server.request('/api/v1/personas', jsonInit({ persona }));
  const body: unknown = await response.json();
  if (response.status !== 201) {
    throw new Error(`persona create failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return z.object({ data: z.object({ id: z.string() }).loose() }).parse(body).data.id;
}

async function setPersonalization(
  server: ApprovalTestServer,
  profile: UpdatePersonalizationProfileRequest['profile'],
): Promise<void> {
  const response = await server.request('/api/v1/personalization/profile', jsonInit({ profile }, 'PUT'));
  if (response.status !== 200) {
    throw new Error(`personalization update failed (${String(response.status)}): ${await response.text()}`);
  }
}

async function setAssistantName(server: ApprovalTestServer, assistantName: string): Promise<void> {
  await setPersonalization(server, {
    assistant_name: assistantName,
    assistant_identity: null,
    voice_guidance: null,
    user_profile: null,
    pinned_preferences: [],
    learned_profile: null,
  });
}

/** Runs one turn to completion by draining its SSE stream, then returns its id. */
async function runTurn(
  server: ApprovalTestServer,
  sessionId: string,
  content: string,
  previousTurnId?: string,
): Promise<string> {
  const response = await server.request(
    `/api/v1/sessions/${sessionId}/turns`,
    jsonInit({
      input: [{ type: 'user.message', content }],
      stream: true,
      ...(previousTurnId === undefined ? {} : { previous_turn_id: previousTurnId }),
    }),
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

/** Runs one turn with several user messages to completion, then returns its id. */
async function runTurnMulti(
  server: ApprovalTestServer,
  options: { sessionId: string; contents: string[]; previousTurnId?: string },
): Promise<string> {
  const response = await server.request(
    `/api/v1/sessions/${options.sessionId}/turns`,
    jsonInit({
      input: options.contents.map(content => ({ type: 'user.message', content })),
      stream: true,
      ...(options.previousTurnId === undefined ? {} : { previous_turn_id: options.previousTurnId }),
    }),
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

function lastCompletion(server: ApprovalTestServer) {
  const requests = server.model.requests();
  const latest = requests[requests.length - 1];
  if (latest === undefined) {
    throw new Error('the scripted model endpoint was never called');
  }
  const system = latest.messages
    .filter(message => message.role === 'system')
    .map(message => (typeof message.content === 'string' ? message.content : ''))
    .join('\n');
  return {
    model: latest.model,
    messages: latest.messages,
    system,
    tools: latest.tools.map(tool => tool.function?.name),
  };
}

async function activePersona(server: ApprovalTestServer, sessionId: string) {
  const response = await server.request(`/api/v1/sessions/${sessionId}/persona`);
  const body = (await response.json()) as { data: Record<string, unknown> | null };
  return body.data;
}

/**
 * Turn summarization is orthogonal to persona switching: without this, every
 * test turn fires a summarizer model call after the answer, so lastCompletion()
 * would read the summarizer's system prompt instead of the persona's. Persist
 * the off override through the real settings surface (same DB the turn path reads).
 */
async function disableTurnSummarization(server: ApprovalTestServer): Promise<void> {
  const response = await server.request('/api/v1/settings/memory-summarize', jsonInit({ enabled: false }, 'PUT'));
  if (response.status !== 200) {
    throw new Error(`disabling turn summarization failed (${String(response.status)}): ${await response.text()}`);
  }
}

describe('persona switching inside one conversation', () => {
  let server: ApprovalTestServer;

  beforeAll(async () => {
    server = await startApprovalTestServer();
    await disableTurnSummarization(server);
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  }, TURN_TIMEOUT_MS);

  it(
    'keeps user personalization but excludes the default assistant identity from a persona model request',
    async () => {
      const sessionId = await createSession(server);
      await createPersona(server, {
        display_name: 'Selene',
        aliases: [],
        instructions: 'Use calm reflective questions without software-testing metaphors.',
        model_name: ALT_MODEL_FQN,
      });
      await setPersonalization(server, {
        assistant_name: 'Testinatrix',
        assistant_identity: 'A pirate software tester.',
        voice_guidance: 'Use pirate language and QA metaphors.',
        user_profile: 'The user prefers plain English.',
        pinned_preferences: ['Keep advice practical.'],
        learned_profile: 'The user values calm explanations.',
      });

      await runTurn(server, sessionId, 'Help me establish the baseline first.');
      const defaultBefore = lastCompletion(server);
      expect(defaultBefore.model).toBe('scripted-model');
      expect(defaultBefore.system).toContain('<assistant-name>Testinatrix</assistant-name>');
      expect(defaultBefore.system).toContain('default assistant is the only active assistant identity');

      await runTurn(server, sessionId, 'Selene, help me think this through.');
      const completion = lastCompletion(server);

      expect(completion.model).toBe('scripted-alt-model');
      expect(completion.system).toContain('<persona-name>Selene</persona-name>');
      expect(completion.system).toContain('<user-profile>The user prefers plain English.</user-profile>');
      expect(completion.system).toContain('Keep advice practical.');
      expect(completion.system).toContain('The user values calm explanations.');
      expect(completion.system).not.toContain('<assistant-name>Testinatrix</assistant-name>');
      expect(completion.system).not.toContain('<assistant-identity>A pirate software tester.</assistant-identity>');
      expect(completion.system).not.toContain('<voice-guidance>Use pirate language and QA metaphors.</voice-guidance>');
      expect(completion.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
      expect(completion.tools).toEqual(defaultBefore.tools);

      await runTurn(server, sessionId, 'switch back to Testinatrix');
      const defaultAfter = lastCompletion(server);
      expect(defaultAfter.model).toBe('scripted-model');
      expect(defaultAfter.system).toContain('<assistant-name>Testinatrix</assistant-name>');
      expect(defaultAfter.system).toContain('default assistant is the only active assistant identity');
      // Successful switches are silent: the notice is ambiguous-only.
      expect(defaultAfter.system).not.toContain('<persona-switch-notice>');
      expect(defaultAfter.system).toContain(
        'Earlier assistant messages may have been written by other configured speakers',
      );
      expect(defaultAfter.system).not.toContain('<persona-name>Selene</persona-name>');
      expect(defaultAfter.messages.filter(message => message.role === 'assistant')).toHaveLength(2);
      expect(defaultAfter.tools).toEqual(defaultBefore.tools);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'guards the default speaker after a persona turn even when no personalization profile exists',
    async () => {
      const isolated = await startApprovalTestServer();
      await disableTurnSummarization(isolated);
      try {
        const sessionId = await createSession(isolated);
        await createPersona(isolated, {
          display_name: 'Sage',
          aliases: [],
          instructions: 'Use calm reflective questions.',
          model_name: ALT_MODEL_FQN,
        });

        await runTurn(isolated, sessionId, 'Sage, help me think this through.');
        expect(lastCompletion(isolated).model).toBe('scripted-alt-model');

        const reset = await isolated.request(
          `/api/v1/sessions/${sessionId}/persona`,
          jsonInit({ persona_id: null }, 'PUT'),
        );
        expect(reset.status).toBe(200);

        await runTurn(isolated, sessionId, 'Continue with the default assistant.');
        const completion = lastCompletion(isolated);
        expect(completion.model).toBe('scripted-model');
        expect(completion.system).toContain('<active-speaker-context>');
        expect(completion.system).toContain('default assistant is the only active assistant identity');
        expect(completion.system).not.toContain('<persona-name>Sage</persona-name>');
        expect(completion.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
      } finally {
        await isolated.close();
      }
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'switches model and identity on an explicit invocation, keeps them for follow-ups, and comes back on request',
    async () => {
      const sessionId = await createSession(server);
      const personaId = await createPersona(server, {
        display_name: 'Zara',
        aliases: ['Z'],
        instructions: 'Answer as a careful archivist.',
        model_name: ALT_MODEL_FQN,
      });

      // A name in ordinary prose is prose.
      await runTurn(server, sessionId, 'I was reading about Zara yesterday.');
      expect(lastCompletion(server).model).toBe('scripted-model');
      expect(lastCompletion(server).system).not.toContain('<persona-name>');
      expect(await activePersona(server, sessionId)).toBeNull();

      // An explicit address is an invocation.
      await runTurn(server, sessionId, 'Zara, what do you make of this?');
      const invoked = lastCompletion(server);
      expect(invoked.model).toBe('scripted-alt-model');
      expect(invoked.system).toContain('<persona-name>Zara</persona-name>');
      expect(invoked.system).toContain('Answer as a careful archivist.');
      expect(await activePersona(server, sessionId)).toMatchObject({
        persona_id: personaId,
        persona_name: 'Zara',
        model_name: ALT_MODEL_FQN,
        source: 'invocation',
      });

      // A natural follow-up that names nobody stays with Zara.
      await runTurn(server, sessionId, 'And what about the second page?');
      expect(lastCompletion(server).model).toBe('scripted-alt-model');
      expect(await activePersona(server, sessionId)).toMatchObject({ source: 'sticky' });

      // The chat's own model setting was never touched.
      const session = (await (await server.request(`/api/v1/sessions/${sessionId}`)).json()) as {
        data: { agent: { spec: { model: { name: string } } } };
      };
      expect(session.data.agent.spec.model.name).toBe(MODEL_FQN);

      await setAssistantName(server, 'Mannie');

      // Natural language changes durable host state before the answer. The
      // model cannot merely claim that Mannie is back while Zara stays active.
      await runTurn(server, sessionId, 'switch back to Mannie');
      const backToDefault = lastCompletion(server);
      expect(backToDefault.model).toBe('scripted-model');
      expect(backToDefault.system).not.toContain('<persona-name>');
      // Successful switches are silent: the notice is ambiguous-only.
      expect(backToDefault.system).not.toContain('<persona-switch-notice>');
      expect(await activePersona(server, sessionId)).toMatchObject({
        source: 'default',
        persona_id: null,
        persona_name: null,
        model_name: null,
      });

      const activations = z
        .object({ data: z.array(z.object({ source: z.string(), persona_id: z.string().nullable() }).loose()) })
        .parse(await (await server.request(`/api/v1/sessions/${sessionId}/persona-activations`)).json());
      expect(activations.data[0]).toMatchObject({ source: 'default', persona_id: null });
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'does not let deterministic direct address bypass negation, and fails closed on ambiguity with a notice',
    async () => {
      const sessionId = await createSession(server);
      await createPersona(server, {
        display_name: 'Vega',
        aliases: [],
        instructions: 'Answer as Vega.',
        model_name: ALT_MODEL_FQN,
      });
      await createPersona(server, {
        display_name: 'Lyra',
        aliases: [],
        instructions: 'Answer as Lyra.',
        model_name: MODEL_FQN,
      });

      const beforeNegation = server.model.requests().length;
      await runTurn(server, sessionId, "Vega, don't answer this.");
      expect(server.model.requests()).toHaveLength(beforeNegation + 1);
      expect(lastCompletion(server).model).toBe('scripted-model');
      expect(lastCompletion(server).system).not.toContain('<persona-name>');
      expect(await activePersona(server, sessionId)).toBeNull();

      // A second clause naming another persona is not single-clause ambiguity:
      // it fails closed with no notice and no switch.
      const beforeCorrection = server.model.requests().length;
      await runTurn(server, sessionId, 'Vega, answer. Could Lyra answer instead?');
      expect(server.model.requests()).toHaveLength(beforeCorrection + 1);
      expect(lastCompletion(server).model).toBe('scripted-model');
      expect(lastCompletion(server).system).not.toContain('<persona-name>');
      expect(lastCompletion(server).system).not.toContain('<persona-switch-notice>');
      expect(await activePersona(server, sessionId)).toBeNull();

      // Genuine single-clause ambiguity fails closed with a notice naming the
      // candidates; the default assistant answers.
      const beforeAmbiguity = server.model.requests().length;
      await runTurn(server, sessionId, 'switch to Vega or Lyra');
      expect(server.model.requests()).toHaveLength(beforeAmbiguity + 1);
      const ambiguous = lastCompletion(server);
      expect(ambiguous.model).toBe('scripted-model');
      expect(ambiguous.system).not.toContain('<persona-name>');
      expect(ambiguous.system).toContain('<persona-switch-notice>');
      expect(ambiguous.system).toContain("'Vega' and 'Lyra' both match");
      expect(await activePersona(server, sessionId)).toBeNull();

      const twoClauseSessionId = await createSession(server);
      const beforeTwoClauses = server.model.requests().length;
      await runTurn(server, twoClauseSessionId, 'Vega, answer. Lyra, answer.');
      expect(server.model.requests()).toHaveLength(beforeTwoClauses + 1);
      expect(lastCompletion(server).model).toBe('scripted-model');
      expect(lastCompletion(server).system).not.toContain('<persona-name>');
      expect(await activePersona(server, twoClauseSessionId)).toBeNull();

      const cancelledSessionId = await createSession(server);
      const beforeCancellation = server.model.requests().length;
      await runTurn(server, cancelledSessionId, 'Vega, answer. Actually, never mind.');
      expect(server.model.requests()).toHaveLength(beforeCancellation + 1);
      expect(lastCompletion(server).model).toBe('scripted-model');
      expect(lastCompletion(server).system).not.toContain('<persona-name>');
      expect(await activePersona(server, cancelledSessionId)).toBeNull();

      const sameClauseCancellationSessionId = await createSession(server);
      const beforeSameClauseCancellation = server.model.requests().length;
      await runTurn(server, sameClauseCancellationSessionId, 'Vega, never mind.');
      expect(server.model.requests()).toHaveLength(beforeSameClauseCancellation + 1);
      expect(lastCompletion(server).model).toBe('scripted-model');
      expect(lastCompletion(server).system).not.toContain('<persona-name>');
      expect(await activePersona(server, sameClauseCancellationSessionId)).toBeNull();

      const politeCancellationSessionId = await createSession(server);
      const beforePoliteCancellation = server.model.requests().length;
      await runTurn(server, politeCancellationSessionId, 'Vega, please never mind.');
      expect(server.model.requests()).toHaveLength(beforePoliteCancellation + 1);
      expect(lastCompletion(server).model).toBe('scripted-model');
      expect(lastCompletion(server).system).not.toContain('<persona-name>');
      expect(await activePersona(server, politeCancellationSessionId)).toBeNull();

      const conversationalCancellationSessionId = await createSession(server);
      const beforeConversationalCancellation = server.model.requests().length;
      await runTurn(server, conversationalCancellationSessionId, 'Vega, okay, never mind.');
      expect(server.model.requests()).toHaveLength(beforeConversationalCancellation + 1);
      expect(lastCompletion(server).model).toBe('scripted-model');
      expect(lastCompletion(server).system).not.toContain('<persona-name>');
      expect(await activePersona(server, conversationalCancellationSessionId)).toBeNull();
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'does not call the model for a turn whose requested parent does not exist',
    async () => {
      const sessionId = await createSession(server);
      await createPersona(server, {
        display_name: 'Orla',
        aliases: [],
        instructions: 'Answer as Orla.',
        model_name: ALT_MODEL_FQN,
      });

      const before = server.model.requests().length;
      const response = await server.request(
        `/api/v1/sessions/${sessionId}/turns`,
        jsonInit({
          input: [{ type: 'user.message', content: 'Could Orla answer this?' }],
          previous_turn_id: 'missing-parent-turn',
          stream: false,
        }),
      );

      expect(response.status).toBe(404);
      expect(server.model.requests()).toHaveLength(before);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'fails closed when the selected persona changes before inference starts',
    async () => {
      const sessionId = await createSession(server);
      await createPersona(server, {
        display_name: 'Keira',
        aliases: [],
        instructions: 'Answer as Keira.',
        model_name: ALT_MODEL_FQN,
      });

      const freshness = jest.spyOn(SqlitePersonaStore.prototype, 'getPersona').mockResolvedValueOnce(undefined);
      try {
        const before = server.model.requests().length;
        const response = await server.request(
          `/api/v1/sessions/${sessionId}/turns`,
          jsonInit({ input: [{ type: 'user.message', content: 'Keira, check this.' }], stream: false }),
        );
        expect(response.status).toBe(409);
        // The persona was gone before admission finished; the answer model never ran.
        expect(server.model.requests()).toHaveLength(before);
      } finally {
        freshness.mockRestore();
      }
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'keeps the active persona when a later message only mentions it',
    async () => {
      const sessionId = await createSession(server);
      await createPersona(server, {
        display_name: 'Sol',
        aliases: [],
        instructions: 'Answer as Sol.',
        model_name: ALT_MODEL_FQN,
      });

      await runTurn(server, sessionId, 'Sol, begin here.');
      await runTurn(server, sessionId, 'I mentioned Sol, but did not ask to switch.');

      expect(lastCompletion(server).model).toBe('scripted-alt-model');
      expect(lastCompletion(server).system).toContain('<persona-name>Sol</persona-name>');
      expect(await activePersona(server, sessionId)).toMatchObject({ persona_name: 'Sol', source: 'sticky' });
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'does not switch on a mentioned, negated, or quoted persona name',
    async () => {
      const sessionId = await createSession(server);
      await createPersona(server, {
        display_name: 'Inez',
        aliases: [],
        instructions: 'Answer as Inez.',
        model_name: ALT_MODEL_FQN,
      });
      await setAssistantName(server, 'Mannie');

      for (const content of [
        'I have a friend named Inez.',
        "Don't switch to Inez; tell me what the name means.",
        'In the transcript, the user said "Inez, help me."',
        'Mannie, I have a friend named Inez.',
      ]) {
        await runTurn(server, sessionId, content);
        expect(lastCompletion(server).model).toBe('scripted-model');
        expect(lastCompletion(server).system).not.toContain('<persona-name>');
        expect(await activePersona(server, sessionId)).toBeNull();
      }
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'switches straight from one persona to another, and never leaks either into a different chat',
    async () => {
      const sessionId = await createSession(server);
      const otherSessionId = await createSession(server);
      await createPersona(server, {
        display_name: 'Milo',
        aliases: [],
        instructions: 'Answer as a terse editor.',
        model_name: ALT_MODEL_FQN,
      });
      await createPersona(server, {
        display_name: 'Rune',
        aliases: [],
        instructions: 'Answer as a patient teacher.',
        model_name: MODEL_FQN,
      });

      await runTurn(server, sessionId, 'ask Milo to look at this');
      expect(lastCompletion(server).system).toContain('<persona-name>Milo</persona-name>');
      expect(lastCompletion(server).system).not.toContain('<persona-switch-notice>');

      await runTurn(server, sessionId, 'let me talk to Rune');
      expect(lastCompletion(server).system).toContain('<persona-name>Rune</persona-name>');
      expect(lastCompletion(server).system).not.toContain('<persona-name>Milo</persona-name>');
      expect(lastCompletion(server).system).not.toContain('<persona-switch-notice>');

      await runTurn(server, sessionId, 'switch to Milo');
      expect(lastCompletion(server).system).toContain('<persona-name>Milo</persona-name>');
      expect(lastCompletion(server).system).not.toContain('<persona-switch-notice>');

      await runTurn(server, sessionId, 'switch to Rune');
      const switched = lastCompletion(server);
      expect(switched.system).toContain('<persona-name>Rune</persona-name>');
      expect(switched.system).not.toContain('<persona-name>Milo</persona-name>');
      expect(switched.system).not.toContain('<persona-switch-notice>');
      expect(switched.model).toBe('scripted-model');

      // The other chat never left the default assistant.
      expect(await activePersona(server, otherSessionId)).toBeNull();
      await runTurn(server, otherSessionId, 'Hello there.');
      expect(lastCompletion(server).system).not.toContain('<persona-name>');
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'records which persona and model answered each turn',
    async () => {
      const sessionId = await createSession(server);
      await createPersona(server, {
        display_name: 'Iris',
        aliases: [],
        instructions: 'Answer as a cartographer.',
        model_name: ALT_MODEL_FQN,
      });

      const turnId = await runTurn(server, sessionId, 'Iris, where does this road go?');
      const log = (await (await server.request(`/api/v1/sessions/${sessionId}/persona-activations`)).json()) as {
        data: { turn_id: string | null; persona_name: string | null; model_name: string | null }[];
      };

      expect(log.data[0]).toMatchObject({
        turn_id: turnId,
        persona_name: 'Iris',
        model_name: ALT_MODEL_FQN,
      });
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'inherits a persona from the actual parent when another fork wrote the newest activation, including legacy parents',
    async () => {
      const sessionId = await createSession(server);
      await createPersona(server, {
        display_name: 'Ash',
        aliases: [],
        instructions: 'Answer as Ash.',
        model_name: ALT_MODEL_FQN,
      });
      await createPersona(server, {
        display_name: 'Briar',
        aliases: [],
        instructions: 'Answer as Briar.',
        model_name: MODEL_FQN,
      });

      const root = await runTurn(server, sessionId, 'Start from the default assistant.');
      const ashFork = await runTurn(server, sessionId, 'Ash, take this branch.', root);
      await runTurn(server, sessionId, 'Briar, take the other branch.', root);

      // Briar owns the newest audit row, but this follow-up explicitly chains
      // from Ash's fork. Global write order must not change branch identity.
      await runTurn(server, sessionId, 'Continue on this branch.', ashFork);
      const completion = lastCompletion(server);
      expect(completion.model).toBe('scripted-alt-model');
      expect(completion.system).toContain('<persona-name>Ash</persona-name>');
      expect(completion.system).not.toContain('<persona-name>Briar</persona-name>');

      // A legacy turn has no atomic snapshot. Make Briar globally newest
      // again, then expose Ash's real stored turn as legacy to the route. The
      // child must use Ash's own activation, never global write order.
      await runTurn(server, sessionId, 'Briar, write after Ash.', root);
      const getCustom = Object.getOwnPropertyDescriptor(TurnHandle.prototype, 'custom')?.get;
      if (getCustom === undefined) {
        throw new Error('TurnHandle.custom getter is unavailable');
      }
      const legacyParent = jest.spyOn(TurnHandle.prototype, 'custom', 'get').mockImplementation(function (
        this: TurnHandle,
      ) {
        return this.id === ashFork ? null : getCustom.call(this);
      });
      try {
        await runTurn(server, sessionId, 'Continue the legacy branch.', ashFork);
      } finally {
        legacyParent.mockRestore();
      }
      const legacyCompletion = lastCompletion(server);
      expect(legacyCompletion.model).toBe('scripted-alt-model');
      expect(legacyCompletion.system).toContain('<persona-name>Ash</persona-name>');
      expect(legacyCompletion.system).not.toContain('<persona-name>Briar</persona-name>');
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'rejects a turn when a manual selection commits during admission, then uses that selection on retry',
    async () => {
      const sessionId = await createSession(server);
      const personaId = await createPersona(server, {
        display_name: 'Nia',
        aliases: [],
        instructions: 'Answer as Nia.',
        model_name: ALT_MODEL_FQN,
      });
      const original = SqlitePersonaStore.prototype.isManualSessionPersonaCurrent;
      const admissionCheck = jest
        .spyOn(SqlitePersonaStore.prototype, 'isManualSessionPersonaCurrent')
        .mockImplementationOnce(async function (this: SqlitePersonaStore, input) {
          const changed = await server.request(
            `/api/v1/sessions/${sessionId}/persona`,
            jsonInit({ persona_id: personaId }, 'PUT'),
          );
          expect(changed.status).toBe(200);
          return await original.call(this, input);
        });
      try {
        const before = server.model.requests().length;
        const response = await server.request(
          `/api/v1/sessions/${sessionId}/turns`,
          jsonInit({ input: [{ type: 'user.message', content: 'Continue.' }], stream: false }),
        );
        expect(response.status).toBe(409);
        expect((await response.json()) as { error: { message: string } }).toMatchObject({
          error: { message: expect.stringContaining('Persona selection changed') },
        });
        expect(server.model.requests()).toHaveLength(before);
      } finally {
        admissionCheck.mockRestore();
      }

      const turns = (await (await server.request(`/api/v1/sessions/${sessionId}/turns`)).json()) as {
        data: { state: { status: string } }[];
      };
      expect(turns.data).toHaveLength(1);
      expect(turns.data[0]?.state.status).toBe('cancelled');

      await runTurn(server, sessionId, 'Continue with the new selection.');
      expect(lastCompletion(server).model).toBe('scripted-alt-model');
      expect(lastCompletion(server).system).toContain('<persona-name>Nia</persona-name>');
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'lets a newer UI selection win over a sticky continuation still being admitted',
    async () => {
      const sessionId = await createSession(server);
      await createPersona(server, {
        display_name: 'Sora',
        aliases: [],
        instructions: 'Answer as Sora.',
        model_name: ALT_MODEL_FQN,
      });
      const niaId = await createPersona(server, {
        display_name: 'Nia Two',
        aliases: [],
        instructions: 'Answer as Nia Two.',
        model_name: ALT_MODEL_FQN,
      });
      await setAssistantName(server, 'Mannie');
      await runTurn(server, sessionId, 'Sora, begin here.');

      const original = SqlitePersonaStore.prototype.recordPersonaActivationIfManualCurrent;
      const admissionCheck = jest
        .spyOn(SqlitePersonaStore.prototype, 'recordPersonaActivationIfManualCurrent')
        .mockImplementationOnce(async function (this: SqlitePersonaStore, input) {
          const changed = await server.request(
            `/api/v1/sessions/${sessionId}/persona`,
            jsonInit({ persona_id: niaId }, 'PUT'),
          );
          expect(changed.status).toBe(200);
          return await original.call(this, input);
        });
      try {
        const response = await server.request(
          `/api/v1/sessions/${sessionId}/turns`,
          jsonInit({ input: [{ type: 'user.message', content: 'Continue, please.' }], stream: false }),
        );
        expect(response.status).toBe(409);
      } finally {
        admissionCheck.mockRestore();
      }

      await runTurn(server, sessionId, 'Continue with the current selection.');
      expect(lastCompletion(server).system).toContain('<persona-name>Nia Two</persona-name>');
    },
    TURN_TIMEOUT_MS,
  );

  // Its own server: this one removes a configured model, which the shared
  // fixture's other scenarios still rely on.
  it(
    'fails visibly when a persona names a model that is gone, and keeps the assignment',
    async () => {
      const server = await startApprovalTestServer();
      await disableTurnSummarization(server);
      try {
        const sessionId = await createSession(server);
        const personaId = await createPersona(server, {
          display_name: 'Vale',
          aliases: [],
          instructions: 'Answer as an auditor.',
          model_name: ALT_MODEL_FQN,
        });
        // Take the model away underneath the persona, as removing it in Settings would.
        await server.request(
          '/api/v1/settings/model-providers',
          jsonInit(
            {
              manifest: {
                type: 'custom',
                name: 'scripted',
                base_url: server.model.baseUrl,
                auth: { api_key: 'scripted-key' },
                models: [
                  {
                    model_id: 'scripted-model',
                    name: 'scripted-model',
                    properties: { context_length: 128000, max_output_tokens: 4096 },
                  },
                ],
              },
            },
            'PUT',
          ),
        );

        const before = server.model.requests().length;
        const response = await server.request(
          `/api/v1/sessions/${sessionId}/turns`,
          jsonInit({ input: [{ type: 'user.message', content: 'Vale, check this.' }], stream: false }),
        );
        expect(response.status).toBe(422);
        const body = (await response.json()) as { error: { message: string } };
        expect(body.error.message).toContain('Vale');
        expect(body.error.message).toContain(ALT_MODEL_FQN);
        // No substitute model answered in its place.
        expect(server.model.requests().length).toBe(before);

        // The assignment survives the failure.
        const personas = (await (await server.request('/api/v1/personas')).json()) as {
          data: { id: string; model_name: string }[];
        };
        expect(personas.data.find(entry => entry.id === personaId)?.model_name).toBe(ALT_MODEL_FQN);
      } finally {
        await server.close();
      }
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'takes the chat back to the default assistant when the active persona is deleted',
    async () => {
      const sessionId = await createSession(server);
      const personaId = await createPersona(server, {
        display_name: 'Thea',
        aliases: [],
        instructions: 'Answer as a librarian.',
        model_name: ALT_MODEL_FQN,
      });

      await runTurn(server, sessionId, 'Thea, where is this filed?');
      expect(lastCompletion(server).model).toBe('scripted-alt-model');

      expect((await server.request(`/api/v1/personas/${personaId}`, { method: 'DELETE' })).status).toBe(200);

      // Nothing is left to route to, so the indicator says default and the next
      // turn runs on the chat's own model — not on the deleted assignment.
      expect(await activePersona(server, sessionId)).toBeNull();
      await runTurn(server, sessionId, 'And the second box?');
      expect(lastCompletion(server).model).toBe('scripted-model');
      expect(lastCompletion(server).system).not.toContain('<persona-name>');

      // Deleting the persona does not rewrite the turns it answered.
      const log = (await (await server.request(`/api/v1/sessions/${sessionId}/persona-activations`)).json()) as {
        data: { persona_name: string | null }[];
      };
      expect(log.data.some(entry => entry.persona_name === 'Thea')).toBe(true);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'ends the turn it created when the persona provenance write fails, and the chat continues',
    async () => {
      const sessionId = await createSession(server);
      await createPersona(server, {
        display_name: 'Wren',
        aliases: [],
        instructions: 'Answer as a scribe.',
        model_name: ALT_MODEL_FQN,
      });

      const write = jest
        .spyOn(SqlitePersonaStore.prototype, 'recordPersonaActivation')
        .mockRejectedValueOnce(new Error('the persona activation log is unavailable'));
      const freeze = jest
        .spyOn(SessionHandle.prototype, 'freezeTurn')
        .mockRejectedValueOnce(new Error('transient turn-store failure'));
      try {
        const failed = await server.request(
          `/api/v1/sessions/${sessionId}/turns`,
          jsonInit({ input: [{ type: 'user.message', content: 'Wren, take a look.' }], stream: false }),
        );
        expect(failed.status).toBe(500);
        expect(freeze).toHaveBeenCalledTimes(2);
      } finally {
        write.mockRestore();
        freeze.mockRestore();
      }

      // The turn the request had already created is terminal. Left running it
      // would belong to no runner, since the generator that writes a turn's
      // terminal state is the one that never started.
      const turns = (await (await server.request(`/api/v1/sessions/${sessionId}/turns`)).json()) as {
        data: { state: { status: string } }[];
      };
      expect(turns.data).toHaveLength(1);
      expect(turns.data[0]?.state.status).toBe('cancelled');

      // And the chat is usable: the next turn runs, and is recorded. A switch
      // to the default assistant is a real state change (Wren is still the
      // sticky identity from the failed turn's snapshot), so it exercises the
      // recovered activation write.
      const turnId = await runTurn(server, sessionId, 'switch to default');
      expect(lastCompletion(server).model).toBe('scripted-model');
      const log = (await (await server.request(`/api/v1/sessions/${sessionId}/persona-activations`)).json()) as {
        data: { turn_id: string | null }[];
      };
      expect(log.data.map(entry => entry.turn_id)).toEqual([turnId]);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'runs the full chat journey: switch, sticky follow-up, silent unknown, back to default by literal and configured names',
    async () => {
      const sessionId = await createSession(server);
      const petraId = await createPersona(server, {
        display_name: 'Petra',
        aliases: [],
        instructions: 'Answer as Petra.',
        model_name: ALT_MODEL_FQN,
      });
      await setAssistantName(server, 'Mannie');

      // The chat starts on the default assistant: no switch, no notice.
      await runTurn(server, sessionId, 'Hello.');
      const hello = lastCompletion(server);
      expect(hello.model).toBe('scripted-model');
      expect(hello.system).not.toContain('<persona-name>');
      expect(hello.system).not.toContain('<persona-switch-notice>');
      expect(await activePersona(server, sessionId)).toBeNull();

      // An explicit switch changes the model and the identity, silently —
      // the notice is ambiguous-only.
      const switchId = await runTurn(server, sessionId, 'switch to Petra');
      const switched = lastCompletion(server);
      expect(switched.model).toBe('scripted-alt-model');
      expect(switched.system).toContain('<persona-name>Petra</persona-name>');
      expect(switched.system).not.toContain('<persona-switch-notice>');
      expect(await activePersona(server, sessionId)).toMatchObject({
        persona_id: petraId,
        source: 'invocation',
        persona_name: 'Petra',
        model_name: ALT_MODEL_FQN,
      });

      // A follow-up with no invocation stays on the persona, silently.
      const followUpId = await runTurn(server, sessionId, 'How are you?');
      const followUp = lastCompletion(server);
      expect(followUp.model).toBe('scripted-alt-model');
      expect(followUp.system).toContain('<persona-name>Petra</persona-name>');
      expect(followUp.system).not.toContain('<persona-switch-notice>');
      expect(await activePersona(server, sessionId)).toMatchObject({ persona_name: 'Petra', source: 'sticky' });

      // An unknown name is a silent no-match: the persona keeps answering.
      const unknownId = await runTurn(server, sessionId, 'switch to Gandalf');
      const unknown = lastCompletion(server);
      expect(unknown.model).toBe('scripted-alt-model');
      expect(unknown.system).toContain('<persona-name>Petra</persona-name>');
      expect(unknown.system).not.toContain('<persona-switch-notice>');
      expect(await activePersona(server, sessionId)).toMatchObject({ persona_name: 'Petra', source: 'sticky' });

      // Back to default by literal name, silently — the notice is ambiguous-only.
      const defaultId = await runTurn(server, sessionId, 'switch to default');
      const backToDefault = lastCompletion(server);
      expect(backToDefault.model).toBe('scripted-model');
      expect(backToDefault.system).not.toContain('<persona-name>');
      expect(backToDefault.system).not.toContain('<persona-switch-notice>');
      expect(await activePersona(server, sessionId)).toMatchObject({
        source: 'default',
        persona_id: null,
        persona_name: null,
        model_name: null,
      });

      // Naming the already-active default by its configured name is a no-op:
      // the turn runs, but no notice and no extra activation row.
      await runTurn(server, sessionId, 'switch back to Mannie');
      const noOp = lastCompletion(server);
      expect(noOp.model).toBe('scripted-model');
      expect(noOp.system).not.toContain('<persona-switch-notice>');
      expect(await activePersona(server, sessionId)).toMatchObject({ source: 'default', persona_id: null });

      const log = (await (await server.request(`/api/v1/sessions/${sessionId}/persona-activations`)).json()) as {
        data: { turn_id: string | null }[];
      };
      // Every turn that ran under a persona records an activation — the
      // switch, the sticky follow-ups, and the switch back. Only the no-op
      // default turn records nothing. The log is newest-first.
      expect(log.data.map(entry => entry.turn_id)).toEqual([defaultId, unknownId, followUpId, switchId]);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'treats a repeat switch to the already-active persona as a no-op with no duplicate activation',
    async () => {
      const sessionId = await createSession(server);
      await createPersona(server, {
        display_name: 'Rhea',
        aliases: [],
        instructions: 'Answer as Rhea.',
        model_name: ALT_MODEL_FQN,
      });

      const switchId = await runTurn(server, sessionId, 'switch to Rhea');
      // A successful switch is silent: the notice is ambiguous-only.
      expect(lastCompletion(server).system).not.toContain('<persona-switch-notice>');

      await runTurn(server, sessionId, 'switch to Rhea');
      const noOp = lastCompletion(server);
      expect(noOp.model).toBe('scripted-alt-model');
      expect(noOp.system).toContain('<persona-name>Rhea</persona-name>');
      expect(noOp.system).not.toContain('<persona-switch-notice>');
      expect(await activePersona(server, sessionId)).toMatchObject({ persona_name: 'Rhea', source: 'invocation' });

      const log = (await (await server.request(`/api/v1/sessions/${sessionId}/persona-activations`)).json()) as {
        data: { turn_id: string | null }[];
      };
      expect(log.data.map(entry => entry.turn_id)).toEqual([switchId]);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'gives a direct chat switch precedence over a concurrent UI selection',
    async () => {
      const sessionId = await createSession(server);
      const sableId = await createPersona(server, {
        display_name: 'Sable',
        aliases: [],
        instructions: 'Answer as Sable.',
        model_name: ALT_MODEL_FQN,
      });
      const tessaId = await createPersona(server, {
        display_name: 'Tessa',
        aliases: [],
        instructions: 'Answer as Tessa.',
        model_name: ALT_MODEL_FQN,
      });

      // A UI selection that commits while the direct switch is being admitted
      // does not 409 it: the deterministic chat invocation wins.
      const original = SqlitePersonaStore.prototype.recordPersonaActivation;
      const admissionWrite = jest
        .spyOn(SqlitePersonaStore.prototype, 'recordPersonaActivation')
        .mockImplementationOnce(async function (this: SqlitePersonaStore, input) {
          const changed = await server.request(
            `/api/v1/sessions/${sessionId}/persona`,
            jsonInit({ persona_id: tessaId }, 'PUT'),
          );
          expect(changed.status).toBe(200);
          return await original.call(this, input);
        });
      try {
        await runTurn(server, sessionId, 'switch to Sable');
      } finally {
        admissionWrite.mockRestore();
      }

      expect(lastCompletion(server).model).toBe('scripted-alt-model');
      expect(lastCompletion(server).system).toContain('<persona-name>Sable</persona-name>');
      expect(await activePersona(server, sessionId)).toMatchObject({
        persona_id: sableId,
        source: 'invocation',
      });
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'scans each user message independently and keeps the last unambiguous switch',
    async () => {
      const sessionId = await createSession(server);
      await createPersona(server, {
        display_name: 'Uma',
        aliases: [],
        instructions: 'Answer as Uma.',
        model_name: ALT_MODEL_FQN,
      });
      await createPersona(server, {
        display_name: 'Vera',
        aliases: [],
        instructions: 'Answer as Vera.',
        model_name: ALT_MODEL_FQN,
      });

      await runTurnMulti(server, {
        sessionId,
        contents: ['switch to Uma', 'How are you?', 'switch to Vera'],
      });
      const lastWins = lastCompletion(server);
      expect(lastWins.model).toBe('scripted-alt-model');
      expect(lastWins.system).toContain('<persona-name>Vera</persona-name>');
      // The last unambiguous switch wins silently: the notice is ambiguous-only.
      expect(lastWins.system).not.toContain('<persona-switch-notice>');
      expect(await activePersona(server, sessionId)).toMatchObject({
        persona_name: 'Vera',
        source: 'invocation',
      });

      // Ambiguity later in the turn does not clear the earlier good switch:
      // the notice asks for clarification while Uma keeps answering.
      await runTurnMulti(server, {
        sessionId,
        contents: ['switch to Uma', 'switch to Uma or Vera'],
      });
      const ambiguous = lastCompletion(server);
      expect(ambiguous.model).toBe('scripted-alt-model');
      expect(ambiguous.system).toContain('<persona-name>Uma</persona-name>');
      expect(ambiguous.system).toContain('<persona-switch-notice>');
      expect(ambiguous.system).toContain("'Uma' and 'Vera' both match");
      expect(await activePersona(server, sessionId)).toMatchObject({
        persona_name: 'Uma',
        source: 'invocation',
      });
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'fails closed on non-English switch phrasing',
    async () => {
      const sessionId = await createSession(server);
      await createPersona(server, {
        display_name: 'Willa',
        aliases: [],
        instructions: 'Answer as Willa.',
        model_name: ALT_MODEL_FQN,
      });

      const before = server.model.requests().length;
      await runTurn(server, sessionId, 'pásame con Willa');
      expect(server.model.requests()).toHaveLength(before + 1);
      expect(lastCompletion(server).model).toBe('scripted-model');
      expect(lastCompletion(server).system).not.toContain('<persona-name>');
      expect(await activePersona(server, sessionId)).toBeNull();

      await runTurn(server, sessionId, 'cambia a Willa, por favor');
      expect(lastCompletion(server).model).toBe('scripted-model');
      expect(lastCompletion(server).system).not.toContain('<persona-name>');
      expect(await activePersona(server, sessionId)).toBeNull();
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'ignores persona invocations carried in user.tool_response input',
    async () => {
      const sessionId = await createSession(server);
      await createPersona(server, {
        display_name: 'Xena',
        aliases: [],
        instructions: 'Answer as Xena.',
        model_name: ALT_MODEL_FQN,
      });

      // A client-side tool result is not the user's voice, even when it names
      // a persona with switch grammar. The scan only reads user.message items.
      const before = server.model.requests().length;
      const response = await server.request(
        `/api/v1/sessions/${sessionId}/turns`,
        jsonInit({
          input: [
            {
              type: 'user.tool_response',
              thread_id: 'synthetic-thread',
              tool_call_id: 'synthetic-call',
              content: 'switch to Xena',
            },
          ],
          stream: false,
        }),
      );
      const body: unknown = await response.json().catch(() => undefined);
      expect(server.model.requests()).toHaveLength(before);
      expect(await activePersona(server, sessionId)).toBeNull();
      expect(JSON.stringify(body)).not.toContain('<persona-name>Xena</persona-name>');
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'answers as the default assistant with no notice or activation when no personas exist',
    async () => {
      const sessionId = await createSession(server);

      await runTurn(server, sessionId, 'switch to default');
      const completion = lastCompletion(server);
      expect(completion.model).toBe('scripted-model');
      expect(completion.system).not.toContain('<persona-switch-notice>');
      expect(await activePersona(server, sessionId)).toBeNull();

      const log = (await (await server.request(`/api/v1/sessions/${sessionId}/persona-activations`)).json()) as {
        data: unknown[];
      };
      expect(log.data).toHaveLength(0);
    },
    TURN_TIMEOUT_MS,
  );
});
