/**
 * A spoken answer goes through the chat's own turns route. The route's refusals (the card changed, ran
 * out of time, may not run) must be told to the person, never reported as done.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { SessionHandle } from '@truefoundry/trueforge-core/agent-session';
import { HeldActionRefusedError } from '@truefoundry/trueforge-core/core';
import { APPROVAL_LINES } from '../../../src/voice/approvalVoice';
import { VoiceSession } from '../../../src/voice/session';
import type { PendingApproval, VoiceTurnRunner } from '../../../src/voice/transport';
import { HttpVoiceTurnRunner } from '../../../src/voice/turnRunner';
import { SESSION_ID, TOOL_CALL_ID, buildApp } from '../../fixtures/turnApprovalApp';
import { sendReplyCard } from '../../fixtures/voice/cards';
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

const says = (): Int16Array => Int16Array.from([...hum(900), ...quiet(900)]);

/** The first message is scripted to leave one card waiting; the answer goes to the real route. */
function cardThenRealRoute({ app, card }: { app: OpenAPIHono; card: PendingApproval }): VoiceTurnRunner {
  const real = new HttpVoiceTurnRunner({
    request: (path, init) => Promise.resolve(app.request(path.replace('/api/v1/sessions', ''), init)),
    sessionId: SESSION_ID,
  });
  return {
    sendMessage: ({ onText }) => {
      onText('I have a draft.');
      return Promise.resolve({ kind: 'done', turnId: 't1', approvals: [card] });
    },
    answerApproval: args => real.answerApproval(args),
    cancel: () => real.cancel(),
  };
}

async function answerAloud({
  words,
  error,
  toolCallId = TOOL_CALL_ID,
}: {
  words: string[];
  error?: Error;
  toolCallId?: string;
}) {
  if (error !== undefined) {
    jest.spyOn(SessionHandle.prototype, 'createTurn').mockRejectedValue(error);
  }
  const app = await buildApp(undefined, { heldAction: true });
  const clock = new ManualClock();
  const transport = new FakeTransport({ clock, voiceApprovals: true });
  const tts = new FakeTts();
  const session = new VoiceSession({
    transport,
    vad: new LoudnessVad(),
    stt: new FakeStt(...words),
    tts,
    turns: cardThenRealRoute({
      app,
      card: { threadId: 'main', toolCallId, card: sendReplyCard(), tier: 3 },
    }),
    clock,
  });
  session.start();
  await feed({ session, clock, samples: says() });
  await session.settled();
  await feed({ session, clock, samples: quiet(9000) });
  await feed({ session, clock, samples: says() });
  await session.settled();
  return tts.sentences.join(' ');
}

describe('a spoken answer through the real turns route', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['changed', APPROVAL_LINES.changed],
    ['expired', APPROVAL_LINES.expired],
    ['not_allowed', APPROVAL_LINES.notAllowed],
    // A card that belongs to another chat is not found in this one.
    ['tool_gone', APPROVAL_LINES.notAllowed],
  ] as const)('tells the person when the route says the card is %s, and never says done', async (reason, line) => {
    const spoken = await answerAloud({
      words: ['send the reply', 'yes send it'],
      error: new HeldActionRefusedError(reason),
    });
    expect(spoken).toContain(line);
    expect(spoken).not.toContain(APPROVAL_LINES.done('send'));
  });
});
