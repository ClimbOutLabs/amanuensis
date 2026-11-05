/**
 * Voice turns against the real server app: the words heard are saved in the chat as an ordinary
 * message, and a card is answered with the same approval call the chat's own buttons make.
 */
import { z } from '@hono/zod-openapi';
import { GetTurnResponseSchema, ListTurnsResponseSchema } from '../../../src/schemas/turn';
import { VoiceSession } from '../../../src/voice/session';
import { HttpVoiceTurnRunner } from '../../../src/voice/turnRunner';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { INERT_SERVER_NAME, INERT_WRITE_TOOL } from '../../fixtures/inertMcpServer';
import { RUN_DIRECTIVE_PREFIX } from '../../fixtures/scriptedModelServer';
import {
  FakeStt,
  FakeTransport,
  FakeTts,
  LoudnessVad,
  ManualClock,
  feed,
  hum,
  quiet,
} from '../../fixtures/voice/fakes';

const TURN_TIMEOUT_MS = 60_000;

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Use the inert connector exactly as instructed.',
  mcp_servers: [{ name: INERT_SERVER_NAME, preload: true, require_approval_for_tools: ['@write'] }],
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
};

const says = (): Int16Array => Int16Array.from([...hum(900), ...quiet(900)]);

describe('voice turns on the real server', () => {
  let server: ApprovalTestServer;

  beforeAll(async () => {
    server = await startApprovalTestServer();
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  }, TURN_TIMEOUT_MS);

  async function newChat(): Promise<string> {
    const response = await server.request('/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: { spec: AGENT_SPEC } }),
    });
    return z.object({ data: z.object({ id: z.string() }).loose() }).parse(await response.json()).data.id;
  }

  async function savedTurns(sessionId: string) {
    const listed = ListTurnsResponseSchema.parse(
      await (await server.request(`/api/v1/sessions/${sessionId}/turns`)).json(),
    );
    return Promise.all(
      listed.data.map(
        async ({ id }) =>
          GetTurnResponseSchema.parse(await (await server.request(`/api/v1/sessions/${sessionId}/turns/${id}`)).json())
            .data,
      ),
    );
  }

  function voiceSession({ sessionId, words }: { sessionId: string; words: string[] }) {
    const clock = new ManualClock();
    const transport = new FakeTransport({ clock, voiceApprovals: true });
    const tts = new FakeTts();
    const session = new VoiceSession({
      transport,
      vad: new LoudnessVad(),
      stt: new FakeStt(...words),
      tts,
      turns: new HttpVoiceTurnRunner({ request: (path, init) => server.request(path, init), sessionId }),
      clock,
    });
    session.start();
    return { session, transport, tts, clock };
  }

  it(
    'saves what was said in the chat as a normal message, with the reply as normal text',
    async () => {
      const sessionId = await newChat();
      const v = voiceSession({ sessionId, words: ['hello there'] });
      await feed({ session: v.session, clock: v.clock, samples: says() });
      await v.session.settled();
      const turns = await savedTurns(sessionId);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.input).toEqual([{ type: 'user.message', content: 'hello there' }]);
      const output = turns[0]?.state.status === 'done' ? turns[0].state.output : undefined;
      expect(typeof output?.content).toBe('string');
      expect(v.tts.sentences.join(' ').length).toBeGreaterThan(0);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'reads back a waiting card, and "yes, approve" runs the held action once, through the chat approval route',
    async () => {
      const sessionId = await newChat();
      server.mcp.resetInvocations();
      const v = voiceSession({
        sessionId,
        words: [`${RUN_DIRECTIVE_PREFIX}${INERT_WRITE_TOOL} please`, 'yes approve'],
      });
      await feed({ session: v.session, clock: v.clock, samples: says() });
      await v.session.settled();
      expect(server.mcp.writeInvocations()).toBe(0);
      expect(v.tts.sentences.join(' ')).toContain("Say 'yes, approve' to go ahead, or 'no'.");
      await feed({ session: v.session, clock: v.clock, samples: quiet(9000) });
      await feed({ session: v.session, clock: v.clock, samples: says() });
      await v.session.settled();
      expect(server.mcp.writeInvocations()).toBe(1);
      const turns = await savedTurns(sessionId);
      expect(turns.map(turn => turn.input?.[0]?.type)).toEqual(['user.message', 'user.tool_approval']);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'does not run it for "yeah"',
    async () => {
      const sessionId = await newChat();
      server.mcp.resetInvocations();
      const v = voiceSession({ sessionId, words: [`${RUN_DIRECTIVE_PREFIX}${INERT_WRITE_TOOL} please`, 'yeah'] });
      await feed({ session: v.session, clock: v.clock, samples: says() });
      await v.session.settled();
      await feed({ session: v.session, clock: v.clock, samples: quiet(9000) });
      await feed({ session: v.session, clock: v.clock, samples: says() });
      await v.session.settled();
      expect(server.mcp.writeInvocations()).toBe(0);
    },
    TURN_TIMEOUT_MS,
  );
});
