import { CALL_LINES, CallTurns, goodTimeAnswer } from '../../../../src/runtime/calls/callTurns';
import { VoiceSession } from '../../../../src/voice/session';
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
      return Promise.resolve({ turns: chatTurns, begin: () => Promise.resolve('chat-1') });
    },
    hangUp: () => {
      hungUp += 1;
    },
    sayMessage: line => {
      void session.say(line);
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
  const OPENING = CALL_LINES.opening({ name: 'Mannie', person: 'Sam', kind: 'something needs you' });

  it('says only the kind of thing until the person says yes, and sends nothing they say to the model', async () => {
    const t = call({ heard: ['who is this', 'yes'] });
    await t.session.say(OPENING, { interruptible: false });
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
    expect(t.tts.sentences.join(' ')).toContain(MESSAGE);
    expect(t.chatTurns.sent).toEqual([]);
  });

  it('reads the message out after a yes, the way every reply after it is read', async () => {
    const t = call({ heard: ['yes'] });
    await t.session.say(OPENING, { interruptible: false });
    t.clock.advance(5_000);
    await speak(t);
    await t.session.settled();
    expect(t.tts.asked).not.toContain(MESSAGE);
    expect(t.tts.sentences.join(' ')).toContain(MESSAGE);
  });

  it('says who the call is for before it asks anything', () => {
    expect(OPENING).toBe('Hi, this is Mannie, calling for Sam. Something needs you. Is this a good time?');
    expect(CALL_LINES.opening({ name: 'Mannie', person: undefined, kind: 'a reminder' })).toBe(
      'Hi, this is Mannie, calling for the person who set me up. A reminder. Is this a good time?',
    );
  });

  it('ignores a reply that began while the opening was still playing, and plays the whole opening', async () => {
    const t = call({ heard: ['hello? yeah?', 'yes'] });
    const opening = t.session.say(OPENING, { interruptible: false });
    await speak(t);
    await opening;
    await t.session.settled();
    expect(t.opened()).toBe(0);
    expect(t.transport.cleared).toBe(0);
    expect(t.tts.sentences).toEqual([
      'Hi, this is Mannie, calling for Sam.',
      'Something needs you.',
      'Is this a good time?',
    ]);
    t.clock.advance(5_000);
    await speak(t);
    await t.session.settled();
    expect(t.opened()).toBe(1);
  });

  it('takes a yes said over the question asked again: only the opening cannot be answered over', async () => {
    const t = call({ heard: ['maybe', 'yes'] });
    await speak(t);
    await t.session.settled();
    expect(t.tts.sentences.join(' ')).toContain(CALL_LINES.askAgain);
    // Said while the question is still playing, in a voice that does not follow it.
    await feed({
      session: t.session,
      clock: t.clock,
      samples: Int16Array.from([...hum(700, 0.3, 1.7), ...quiet(900)]),
    });
    await t.session.settled();
    expect(t.transport.cleared).toBe(1);
    expect(t.opened()).toBe(1);
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
    const t = call({ heard: ['maybe', 'what'] });
    await speak(t);
    await t.session.settled();
    t.clock.advance(5_000);
    await speak(t);
    await t.session.settled();
    expect(t.tts.sentences.join(' ')).toContain(CALL_LINES.askAgain);
    expect(t.tts.sentences.join(' ')).toContain('I will leave it in the app for you.');
    expect(t.hungUp()).toBe(1);
  });

  it('counts silence after the question as an answer it did not catch', () => {
    const t = call({ heard: [] });
    expect(t.turns.heardNothing()).toEqual({ line: CALL_LINES.askAgain, end: false });
    expect(t.turns.heardNothing()).toEqual({ line: CALL_LINES.giveUp, end: true });
    expect(t.turns.heardNothing()).toBeUndefined();
    expect(t.opened()).toBe(0);
  });

  it('stops counting silence once the person said yes', async () => {
    const t = call({ heard: ['yes'] });
    await speak(t);
    await t.session.settled();
    expect(t.turns.heardNothing()).toBeUndefined();
  });

  it('takes only a short, plain yes as a yes', () => {
    for (const yes of ['Yes.', 'Yeah.', 'Yep', 'Yup!', 'Sure.', 'Okay.', 'Yes, sure.', 'Yeah yeah okay']) {
      expect(goodTimeAnswer(yes)).toBe('yes');
    }
  });

  it.each([
    'Hello? Yeah?',
    'Go away',
    'Who is this? Okay',
    "I'm fine, who's calling?",
    'Sure, hold on, let me get her',
    'Mom, phone! Okay hang on',
    'Is this a sales call? Alright whatever',
    'Hi, you have reached Sam. Please leave a message, okay?',
    'Go ahead',
    'Fine',
    'OK',
    'Alright',
    'Yes yes yes yes',
    'Yeah?',
    'Okay?',
    'Yes ?',
    'Yes?!',
    'Yes？',
    'Yeah¿',
    'Yeah? Yeah.',
    'Yes؟',
    'Yes‽',
    'Yes⸮',
    'Yes︖',
    'Yes﹖',
    'Yes⁇',
    'Yes⁈',
    'Yes❓',
    'Yes❔',
  ])('does not take "%s" as a yes', heard => {
    expect(goodTimeAnswer(heard)).toBe('unclear');
  });

  it.each(['No problem, go ahead', "I'm not busy", 'Why not, sure', 'No worries'])(
    'does not take "%s" as a no, and asks again',
    heard => {
      expect(goodTimeAnswer(heard)).toBe('unclear');
    },
  );

  it.each(["No, I can't talk", 'not a good time', 'Busy', 'Nope', 'Later please'])('takes "%s" as a no', heard => {
    expect(goodTimeAnswer(heard)).toBe('no');
  });
});

describe('approvals on a phone call', () => {
  it('refuses to answer an approval even when asked to directly', async () => {
    const t = call({ heard: [] });
    const outcome = await t.turns.answerApproval();
    expect(outcome).toEqual({ kind: 'refused', reason: 'not_allowed' });
    expect(t.chatTurns.answers).toEqual([]);
  });
});

describe('a turn that cannot be run', () => {
  const never = new AbortController().signal;

  it('ends as a failed turn when the chat cannot be opened, and when the chat’s own turn throws', async () => {
    const failures: unknown[] = [];
    const opening = new CallTurns({
      message: MESSAGE,
      openChat: () => Promise.reject(new Error('database went away')),
      hangUp: () => undefined,
      sayMessage: () => undefined,
      failed: error => failures.push(error),
    });
    await expect(opening.sendMessage({ text: 'yes', signal: never, onText: () => undefined })).resolves.toEqual({
      kind: 'failed',
    });
    expect(failures).toHaveLength(1);
    const open = new CallTurns({
      message: MESSAGE,
      openChat: () =>
        Promise.resolve({
          turns: new FakeTurns({ message: [] }),
          begin: () => Promise.resolve('chat-1'),
        }),
      hangUp: () => undefined,
      sayMessage: () => undefined,
    });
    await open.sendMessage({ text: 'yes', signal: never, onText: () => undefined });
    jest.spyOn(FakeTurns.prototype, 'sendMessage').mockRejectedValueOnce(new Error('model failed'));
    await expect(open.sendMessage({ text: 'and then?', signal: never, onText: () => undefined })).resolves.toEqual({
      kind: 'failed',
    });
  });
});
