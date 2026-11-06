import { CALL_LINES, CallTurns, goodTimeAnswer } from '../../../../src/runtime/calls/callTurns';
import { APPROVAL_LINES } from '../../../../src/voice/approvalVoice';
import { VoiceSession } from '../../../../src/voice/session';
import { approval, sendReplyCard } from '../../../fixtures/voice/cards';
import {
  FakeStt,
  FakeTransport,
  FakeTts,
  FakeTurns,
  LoudnessVad,
  ManualClock,
  feed,
  hum,
  quiet,
  type ScriptedReply,
} from '../../../fixtures/voice/fakes';

const MESSAGE = 'Your 3pm with Dana Reyes clashes with the school pickup.';

/** A person speaking, then the room going quiet: one finished utterance. */
const says = (): Int16Array => Int16Array.from([...hum(900), ...quiet(900)]);

function call({ heard, chatReplies = [] }: { heard: string[]; chatReplies?: ScriptedReply[] }) {
  const clock = new ManualClock();
  // A line with voice approvals off, as a phone line says. It hears 16 kHz samples so the test can speak plainly.
  const transport = new FakeTransport({ clock, voiceApprovals: false, outputFormat: 'mulaw8k' });
  const tts = new FakeTts();
  const chatTurns = new FakeTurns({ message: chatReplies, approval: [{ text: ['Sent.'] }] });
  let hungUp = 0;
  let opened = 0;
  const turns = new CallTurns({
    message: MESSAGE,
    openChat: () => {
      opened += 1;
      return Promise.resolve({ session_id: 'chat-1', turns: chatTurns, close: () => undefined });
    },
    hangUp: () => {
      hungUp += 1;
    },
  });
  const session = new VoiceSession({
    transport,
    vad: new LoudnessVad(),
    stt: new FakeStt(...heard),
    tts,
    turns,
    clock,
  });
  session.start();
  return {
    session,
    clock,
    tts,
    turns,
    chatTurns,
    transport,
    hungUp: () => hungUp,
    opened: () => opened,
  };
}

function speak(t: ReturnType<typeof call>) {
  return feed({ session: t.session, clock: t.clock, samples: says() });
}

describe('a phone call in private mode', () => {
  it('says only the kind of thing until the person says yes, and sends nothing they say to the model', async () => {
    const t = call({ heard: ['who is this', 'yes go ahead'] });
    await t.session.say(CALL_LINES.opening({ name: 'Mannie', kind: 'something needs you' }));
    t.clock.advance(5_000);
    await speak(t);
    await t.session.settled();
    expect(t.chatTurns.sent).toEqual([]);
    expect(t.opened()).toBe(0);
    expect(t.tts.sentences.join(' ')).not.toContain('Dana');
    expect(t.tts.sentences).toContain('Is this a good time?');
    t.clock.advance(5_000);
    await speak(t);
    await t.session.settled();
    expect(t.opened()).toBe(1);
    expect(t.tts.sentences.join(' ')).toContain(`${MESSAGE} Want me to do something about it?`);
    expect(t.chatTurns.sent).toEqual([]);
  });

  it('says goodbye and hangs up on a no, and never opens the chat', async () => {
    const t = call({ heard: ['no not now'] });
    await speak(t);
    await t.session.settled();
    expect(t.tts.sentences.join(' ')).toBe(CALL_LINES.notNow);
    expect(t.hungUp()).toBe(1);
    expect(t.opened()).toBe(0);
  });

  it('asks once more when it did not catch the answer, then leaves it in the app', async () => {
    const t = call({ heard: ['hmm', 'what'] });
    await speak(t);
    await t.session.settled();
    t.clock.advance(5_000);
    await speak(t);
    await t.session.settled();
    expect(t.tts.sentences.join(' ')).toContain('Please say yes or no.');
    expect(t.tts.sentences.join(' ')).toContain('I will leave it in the app for you.');
    expect(t.hungUp()).toBe(1);
  });

  it('tells yes from no in plain words', () => {
    expect(goodTimeAnswer('Yes.')).toBe('yes');
    expect(goodTimeAnswer('Sure, go ahead')).toBe('yes');
    expect(goodTimeAnswer("No, I can't talk")).toBe('no');
    expect(goodTimeAnswer('not a good time')).toBe('no');
    expect(goodTimeAnswer('is this a good time')).toBe('unclear');
  });
});

describe('approvals on a phone call', () => {
  it('leaves a card the call asked for waiting in the app, and never approves it by voice', async () => {
    const t = call({
      heard: ['yes', 'reply to dana that I will be late', 'yes send it', 'yes, send it'],
      chatReplies: [{ text: ['I wrote the reply.'], approvals: [approval(sendReplyCard())] }],
    });
    await speak(t);
    await t.session.settled();
    t.clock.advance(5_000);
    await speak(t);
    await t.session.settled();
    expect(t.chatTurns.sent).toEqual(['reply to dana that I will be late']);
    expect(t.tts.sentences).toContain(APPROVAL_LINES.leftForTheApp);
    // Nothing the card says is read back as something to confirm.
    expect(t.tts.sentences.join(' ')).not.toContain("Say 'yes, send it'");
    for (let n = 0; n < 2; n += 1) {
      t.clock.advance(5_000);
      await speak(t);
      await t.session.settled();
    }
    expect(t.chatTurns.answers).toEqual([]);
    expect(t.turns.followUps).toBe(1);
    // The exact phrase became a normal message in the chat, never an answer to the card.
    expect(t.chatTurns.sent.slice(1)).toEqual(['yes send it', 'yes, send it']);
  });

  it('refuses to answer an approval even when asked to directly', async () => {
    const t = call({ heard: [] });
    const outcome = await t.turns.answerApproval();
    expect(outcome).toEqual({ kind: 'refused', reason: 'not_allowed' });
    expect(t.chatTurns.answers).toEqual([]);
  });
});
