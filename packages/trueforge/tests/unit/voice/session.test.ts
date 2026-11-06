import type { OutputFormat } from '../../../src/voice/audio';
import { VoiceSession, type TurnLatency } from '../../../src/voice/session';
import {
  approval,
  calendarCard,
  cancelScheduleCard,
  dentistCard,
  moneyCard,
  sendReplyCard,
  shellCard,
  typedOnlyCards,
} from '../../fixtures/voice/cards';
import {
  FakeStt,
  FakeTransport,
  FakeTts,
  FakeTurns,
  Loopback,
  LoudnessVad,
  ManualClock,
  feed,
  hum,
  pcmBytes,
  quiet,
  type ScriptedReply,
} from '../../fixtures/voice/fakes';

/** A person speaking for `ms`, then the room going quiet for `after` ms: one finished utterance. */
const says = (ms = 900, after = 900): Int16Array => Int16Array.from([...hum(ms), ...quiet(after)]);

function setup({
  voiceApprovals = true,
  stt = [],
  message = [],
  approval: approvalReplies = [],
  outputFormat = 'pcm16',
}: {
  voiceApprovals?: boolean;
  stt?: string[];
  message?: ScriptedReply[];
  approval?: ScriptedReply[];
  outputFormat?: OutputFormat;
}) {
  const clock = new ManualClock();
  const transport = new FakeTransport({ clock, voiceApprovals, outputFormat });
  const tts = new FakeTts();
  const turns = new FakeTurns({ message, approval: approvalReplies });
  const notes: string[] = [];
  const latencies: TurnLatency[] = [];
  const session = new VoiceSession({
    transport,
    vad: new LoudnessVad(),
    stt: new FakeStt(...stt),
    tts,
    turns,
    clock,
    onNote: note => notes.push(note),
    onLatency: latency => latencies.push(latency),
  });
  session.start();
  return { session, transport, tts, turns, clock, notes, latencies };
}

describe('a spoken turn', () => {
  it('goes through the normal turn route as the words that were heard, and the reply is spoken sentence by sentence', async () => {
    const t = setup({
      stt: ['what is on my calendar'],
      message: [{ text: ['You have two meetings. ', 'The first is at nine.'] }],
    });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.turns.sent).toEqual(['what is on my calendar']);
    expect(t.tts.sentences).toEqual(['You have two meetings.', 'The first is at nine.']);
    expect(t.transport.audio.length).toBeGreaterThan(0);
    expect(t.transport.heard()).toEqual(['what is on my calendar']);
    expect(t.transport.events).toContainEqual({ type: 'turn_saved', turn_id: 'turn-1' });
    expect(t.transport.states()).toEqual(['listening', 'thinking', 'speaking']);
  });

  it('is silent and sends nothing when nothing was understood', async () => {
    const t = setup({ stt: [''] });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.turns.sent).toEqual([]);
    expect(t.transport.audio).toEqual([]);
    expect(t.transport.states().at(-1)).toBe('listening');
  });

  it('works the same on a phone line: mu-law in, mu-law out', async () => {
    const t = setup({ stt: ['hello'], message: [{ text: ['Hi there.'] }], outputFormat: 'mulaw8k' });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.turns.sent).toEqual(['hello']);
    expect(t.transport.audio.length).toBeGreaterThan(0);
  });

  it('returns to listening when the reply has finished playing', async () => {
    const t = setup({ stt: ['hello'], message: [{ text: ['Hi there.'] }] });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.transport.states().at(-1)).toBe('speaking');
    t.clock.advance(2000);
    expect(t.transport.states().at(-1)).toBe('listening');
  });
});

describe('a line no turn asked for', () => {
  it('speaks it in the line’s own format, sends nothing to the model, and can be talked over', async () => {
    const t = setup({ stt: ['hello?'], message: [{ text: ['Hi.'] }], outputFormat: 'mulaw8k' });
    await t.session.say('Hi, it is your assistant. Is this a good time? Something needs you.');
    expect(t.tts.sentences).toEqual(['Hi, it is your assistant.', 'Is this a good time?', 'Something needs you.']);
    expect(t.turns.sent).toEqual([]);
    expect(t.transport.states()).toContain('speaking');
    const clearedBefore = t.transport.cleared;
    await feed({ session: t.session, clock: t.clock, samples: hum(700, 0.3, 1.7) });
    expect(t.transport.cleared).toBe(clearedBefore + 1);
    await feed({ session: t.session, clock: t.clock, samples: quiet(900) });
    await t.session.settled();
    expect(t.turns.sent).toEqual(['hello?']);
    expect(t.turns.spokenOver).toEqual([false]);
  });

  it('can hold the floor: talking over it does not stop it, and the turn is told it began over that line', async () => {
    const t = setup({
      stt: ['yeah?', 'yes'],
      message: [{ text: ['Okay.'] }, { text: ['Okay.'] }],
      outputFormat: 'mulaw8k',
    });
    await t.session.say('Hi, it is your assistant. Something needs you. Is this a good time?', {
      interruptible: false,
    });
    const clearedBefore = t.transport.cleared;
    await feed({ session: t.session, clock: t.clock, samples: hum(700, 0.3, 1.7) });
    await feed({ session: t.session, clock: t.clock, samples: quiet(900) });
    await t.session.settled();
    expect(t.transport.cleared).toBe(clearedBefore);
    expect(t.tts.sentences.slice(0, 3)).toEqual([
      'Hi, it is your assistant.',
      'Something needs you.',
      'Is this a good time?',
    ]);
    t.clock.advance(5_000);
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.turns.sent).toEqual(['yeah?', 'yes']);
    expect(t.turns.spokenOver).toEqual([true, false]);
  });
});

describe('barge-in', () => {
  it('stops playback at once when the person talks over the assistant, and treats it as a new turn', async () => {
    const t = setup({
      stt: ['tell me a story', 'stop, something else'],
      message: [
        { text: ['Once upon a time. ', 'There was a fox. ', 'It was very clever. ', 'It lived in a forest. '] },
        { text: ['Okay.'] },
      ],
    });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.transport.audio.length).toBeGreaterThan(0);
    const clearedBefore = t.transport.cleared;
    // The person speaks over the reply; playback is still going.
    await feed({ session: t.session, clock: t.clock, samples: hum(700, 0.3, 1.7) });
    expect(t.transport.cleared).toBe(clearedBefore + 1);
    expect(t.notes).toContain('barge_in');
    await feed({ session: t.session, clock: t.clock, samples: quiet(900) });
    await t.session.settled();
    expect(t.turns.sent).toEqual(['tell me a story', 'stop, something else']);
    expect(t.transport.states()).toContain('listening');
  });

  it('does not cut off the assistant for a cough or a click', async () => {
    const t = setup({
      stt: ['tell me a story'],
      message: [{ text: ['Once upon a time. ', 'There was a fox. ', 'It was clever.'] }],
    });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    const clearedBefore = t.transport.cleared;
    await feed({
      session: t.session,
      clock: t.clock,
      samples: Int16Array.from([...hum(160, 0.3, 1.7), ...quiet(400)]),
    });
    expect(t.transport.cleared).toBe(clearedBefore);
  });
});

describe('talking while a turn is still being worked on', () => {
  it('stops that turn and starts the new one', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const clock = new ManualClock();
    const transport = new FakeTransport({ clock, voiceApprovals: true });
    const turns = new FakeTurns(
      { message: [{ text: ['First answer.'] }, { text: ['Second answer.'] }] },
      { gate: () => held },
    );
    const tts = new FakeTts();
    const session = new VoiceSession({
      transport,
      vad: new LoudnessVad(),
      stt: new FakeStt('first question', 'second question'),
      tts,
      turns,
      clock,
    });
    session.start();
    await feed({ session, clock, samples: says() });
    // The first turn is still running when the person speaks again.
    await feed({ session, clock, samples: says() });
    release();
    await session.settled();
    expect(turns.cancels).toBeGreaterThan(0);
    expect(turns.sent).toEqual(['first question', 'second question']);
  });
});

describe('echo of the assistant own voice', () => {
  it('neither cuts the assistant off nor starts a turn when its voice comes back through the microphone', async () => {
    const t = setup({
      stt: ['tell me a story', 'the echo, heard as words'],
      message: [
        { text: ['Once upon a time. ', 'There was a fox. ', 'It was very clever. ', 'It lived in a forest. '] },
      ],
    });
    const echo = new Loopback(t.transport, t.clock, { gain: 0.4, delayMs: 96 });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    const clearedBefore = t.transport.cleared;
    // Four seconds of an empty room, with only the assistant's voice heard from the speaker.
    await feed({ session: t.session, clock: t.clock, samples: quiet(4000), echo });
    await t.session.settled();
    expect(t.transport.cleared).toBe(clearedBefore);
    expect(t.notes).not.toContain('barge_in');
    expect(t.turns.sent).toEqual(['tell me a story']);
  });

  it('does not take the read-back, played back into the microphone, as an approval', async () => {
    const t = setup({
      stt: ['send the reply', 'yes send it'],
      message: [{ text: ['I have a draft.'], approvals: [approval(sendReplyCard())] }],
    });
    const echo = new Loopback(t.transport, t.clock, { gain: 0.4, delayMs: 96 });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    await feed({ session: t.session, clock: t.clock, samples: quiet(8000), echo });
    await t.session.settled();
    expect(t.turns.answers).toEqual([]);
    expect(t.transport.cleared).toBe(0);
  });

  it('ignores the exact phrase when it starts within 1.5 seconds after the assistant stops, then still takes it later', async () => {
    const t = setup({
      stt: ['send the reply', 'yes send it', 'yes send it'],
      message: [{ text: ['I have a draft.'], approvals: [approval(sendReplyCard())] }],
      approval: [{ text: ['Sent it to Victor.'] }],
    });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    // Quiet until the read-back has finished playing.
    for (let step = 0; step < 400 && t.transport.states().at(-1) !== 'listening'; step += 1) {
      await feed({ session: t.session, clock: t.clock, samples: quiet(32) });
    }
    expect(t.transport.states().at(-1)).toBe('listening');
    // Half a second after it stopped: inside the guard time, so this is not an answer.
    await feed({ session: t.session, clock: t.clock, samples: Int16Array.from([...quiet(500), ...says(900, 900)]) });
    await t.session.settled();
    expect(t.turns.answers).toEqual([]);
    // Well after the guard time, the same words are an answer.
    await feed({ session: t.session, clock: t.clock, samples: Int16Array.from([...quiet(2500), ...says(900, 900)]) });
    await t.session.settled();
    expect(t.turns.answers).toEqual([{ decision: 'allow', toolCallId: 'call-1' }]);
  });
});

describe('approval by voice', () => {
  async function readBack(replies: Parameters<typeof setup>[0]) {
    const t = setup({ ...replies, stt: ['send the reply', ...(replies.stt ?? [])] });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    // Let the read-back finish and the guard time pass.
    await feed({ session: t.session, clock: t.clock, samples: quiet(9000) });
    await t.session.settled();
    return t;
  }
  const withCard = (card = sendReplyCard()): ScriptedReply[] => [
    { text: ['I have a draft.'], approvals: [approval(card)] },
  ];

  it('reads the card back in plain words, ending with how to answer', async () => {
    const t = await readBack({ message: withCard() });
    expect(t.tts.sentences).toEqual([
      'I have a draft.',
      "I'll send this reply to Victor.",
      'The subject is: Re: Thursday',
      'It says: Thursday at three works for me.',
      'See you then.',
      "Say 'yes, send it' to send, or 'no'.",
    ]);
  });

  it('reads a calendar event with its time and description, and a schedule with its task', async () => {
    const event = await readBack({ message: withCard(dentistCard) });
    const eventSpeech = event.tts.sentences.join(' ');
    expect(eventSpeech).toContain('Dentist on Friday at 9 for 1 hour');
    expect(eventSpeech).toContain('Bring the form.');
    const schedule = await readBack({ message: withCard(cancelScheduleCard) });
    expect(schedule.tts.sentences.join(' ')).toContain('Summarize the week');
  });

  it('sends on the exact phrase, says what was done, and answers the card with the same call the chat uses', async () => {
    const t = await readBack({
      message: withCard(),
      stt: ['Yes, send it.'],
      approval: [{ text: ['Sent to Victor.'] }],
    });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.turns.answers).toEqual([{ decision: 'allow', toolCallId: 'call-1' }]);
    expect(t.tts.sentences.at(-1)).toBe('Sent to Victor.');
  });

  it('says a short line when the answering turn has no words of its own', async () => {
    const t = await readBack({ message: withCard(), stt: ['yes, send it'], approval: [{}] });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.tts.sentences.at(-1)).toBe('Done. I sent it.');
  });

  it.each([
    'yeah',
    'yes',
    'sure, go ahead',
    'yes, send it now',
    'yes approve',
    'send it',
    'um, yes, send it',
    "yes, don't send it",
    'no, yes send it',
    'yes, send it to Bob',
    'yes, send it?',
  ])('does not send on %p, and leaves the card waiting', async answer => {
    const t = await readBack({ message: withCard(), stt: [answer, 'yes send it'], approval: [{ text: ['Sent.'] }] });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.turns.answers).toEqual([]);
    // Still waiting: once the reminder has been said, the exact phrase still works.
    await feed({ session: t.session, clock: t.clock, samples: quiet(6000) });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.turns.answers).toEqual([{ decision: 'allow', toolCallId: 'call-1' }]);
  });

  it('leaves the card waiting through silence', async () => {
    const t = await readBack({ message: withCard() });
    await feed({ session: t.session, clock: t.clock, samples: quiet(10_000) });
    await t.session.settled();
    expect(t.turns.answers).toEqual([]);
  });

  it('turns it down on a plain "no"', async () => {
    const t = await readBack({ message: withCard(), stt: ['No.'], approval: [{}] });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.turns.answers).toEqual([{ decision: 'deny', toolCallId: 'call-1' }]);
  });

  it('asks for the phrase that matches the card: cancel, and approve, are not interchangeable with send', async () => {
    const cancel = await readBack({
      message: withCard(cancelScheduleCard),
      stt: ['yes send it', 'yes, cancel it'],
      approval: [{}],
    });
    await feed({ session: cancel.session, clock: cancel.clock, samples: says() });
    await cancel.session.settled();
    expect(cancel.tts.sentences).toContain("Say 'yes, cancel it' to cancel it, or 'no'.");
    expect(cancel.turns.answers).toEqual([]);
    await feed({ session: cancel.session, clock: cancel.clock, samples: quiet(6000) });
    await feed({ session: cancel.session, clock: cancel.clock, samples: says() });
    await cancel.session.settled();
    expect(cancel.turns.answers).toEqual([{ decision: 'allow', toolCallId: 'call-1' }]);

    const plain = await readBack({ message: withCard(calendarCard), stt: ['yes, approve'], approval: [{}] });
    await feed({ session: plain.session, clock: plain.clock, samples: says() });
    await plain.session.settled();
    expect(plain.turns.answers).toEqual([{ decision: 'allow', toolCallId: 'call-1' }]);
  });

  it('refuses to say it is done when the card no longer matches what was read', async () => {
    const t = await readBack({
      message: withCard(),
      stt: ['yes send it'],
      approval: [{ outcome: 'refused', refusal: 'changed' }],
    });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.turns.answers).toHaveLength(1);
    const last = t.tts.sentences.at(-1) ?? '';
    expect(last).toContain('no longer matches');
    expect(t.tts.sentences.join(' ')).not.toContain('Done');
  });

  it.each([
    ['a shell command', shellCard],
    ['a payment', moneyCard],
  ])('leaves %s for the screen and never asks for a spoken answer', async (_name, card) => {
    const t = await readBack({ message: withCard(card), stt: ['yes approve', 'yes send it'] });
    expect(t.tts.sentences.at(-1)).toBe("I've left it in the app for you to approve.");
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.turns.answers).toEqual([]);
  });

  it.each(typedOnlyCards)('leaves a card with %s for the screen', async (_name, card) => {
    const t = await readBack({ message: withCard(card), stt: ['yes send it'] });
    expect(t.tts.sentences.at(-1)).toBe("I've left it in the app for you to approve.");
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.turns.answers).toEqual([]);
  });

  it('takes the exact phrase once: saying it again does nothing', async () => {
    const t = await readBack({
      message: withCard(),
      stt: ['yes send it', 'yes send it'],
      approval: [{ text: ['Sent.'] }, { text: ['Sent again.'] }],
    });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    await feed({ session: t.session, clock: t.clock, samples: quiet(6000) });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.turns.answers).toEqual([{ decision: 'allow', toolCallId: 'call-1' }]);
    expect(t.tts.sentences.join(' ')).not.toContain('Sent again');
  });

  it('never answers by voice on a line that switched voice approvals off', async () => {
    const t = await readBack({ message: withCard(), voiceApprovals: false, stt: ['yes send it'] });
    expect(t.tts.sentences.at(-1)).toBe("I've left it in the app for you to approve.");
    expect(t.tts.sentences.join(' ')).not.toContain('Victor');
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.turns.answers).toEqual([]);
  });

  it('leaves several waiting cards for the screen', async () => {
    const t = await readBack({
      message: [
        {
          text: ['Two things.'],
          approvals: [approval(sendReplyCard()), { ...approval(sendReplyCard()), toolCallId: 'call-2' }],
        },
      ],
    });
    expect(t.tts.sentences.at(-1)).toBe("I've left it in the app for you to approve.");
  });
});

describe('answering a waiting card', () => {
  async function waiting({ body = 'Thursday at three works for me.', stt }: { body?: string; stt: string[] }) {
    const t = setup({
      stt: ['send the reply', ...stt],
      message: [{ text: ['I have a draft.'], approvals: [approval(sendReplyCard(body))] }],
      approval: [{}, {}],
    });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    await feed({ session: t.session, clock: t.clock, samples: quiet(9000) });
    await t.session.settled();
    return t;
  }

  it('takes a plain "no" even when the read-back held the word "no"', async () => {
    const t = await waiting({ body: 'No worries, see you Friday.', stt: ['No.'] });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.turns.answers).toEqual([{ decision: 'deny', toolCallId: 'call-1' }]);
  });

  it('runs other speech as a new turn once the reminder has been said, and leaves the card on the screen', async () => {
    const t = await waiting({ stt: ['what time is it', 'what is the weather'] });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.tts.sentences.at(-1)).toContain('still waiting for your answer');
    expect(t.turns.sent).toEqual(['send the reply']);
    await feed({ session: t.session, clock: t.clock, samples: quiet(6000) });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.turns.sent).toEqual(['send the reply', 'what is the weather']);
    expect(t.turns.answers).toEqual([]);
  });

  it('says to say it again when the answer came too soon after the assistant stopped', async () => {
    const t = setup({
      stt: ['send the reply', 'yes send it'],
      message: [{ text: ['I have a draft.'], approvals: [approval(sendReplyCard())] }],
    });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    for (let step = 0; step < 400 && t.transport.states().at(-1) !== 'listening'; step += 1) {
      await feed({ session: t.session, clock: t.clock, samples: quiet(32) });
    }
    await feed({ session: t.session, clock: t.clock, samples: Int16Array.from([...quiet(500), ...says(900, 900)]) });
    await t.session.settled();
    expect(t.tts.sentences.at(-1)).toBe('Say that again.');
    expect(t.turns.answers).toEqual([]);
  });

  it('judges the guard time by when the audio arrived, so a backed-up queue cannot let an echo through', async () => {
    const t = setup({
      stt: ['send the reply', 'yes send it'],
      message: [{ text: ['I have a draft.'], approvals: [approval(sendReplyCard())] }],
    });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    for (let step = 0; step < 400 && t.transport.states().at(-1) !== 'listening'; step += 1) {
      await feed({ session: t.session, clock: t.clock, samples: quiet(32) });
    }
    await feed({ session: t.session, clock: t.clock, samples: quiet(200) });
    // The words arrive 0.2 s after the assistant stopped, but are only listened to 3 s later.
    const late = Int16Array.from([...hum(640), ...quiet(800)]);
    for (let offset = 0; offset + 512 <= late.length; offset += 512) {
      t.session.pushAudio(pcmBytes(late.subarray(offset, offset + 512)));
    }
    t.clock.advance(3000);
    await t.session.settled();
    expect(t.turns.answers).toEqual([]);
  });

  it('cannot be answered after the person talked over its read-back', async () => {
    const t = setup({
      stt: ['send the reply', 'yes send it'],
      message: [{ text: ['I have a draft.'], approvals: [approval(sendReplyCard())] }, { text: ['Okay.'] }],
    });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    await feed({
      session: t.session,
      clock: t.clock,
      samples: Int16Array.from([...hum(700, 0.3, 1.7), ...quiet(900)]),
    });
    await t.session.settled();
    expect(t.turns.answers).toEqual([]);
    expect(t.turns.sent).toEqual(['send the reply', 'yes send it']);
  });
});

describe('what counts as talking over the assistant', () => {
  function gated() {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const clock = new ManualClock();
    const transport = new FakeTransport({ clock, voiceApprovals: true });
    const turns = new FakeTurns(
      { message: [{ text: ['First answer.'] }, { text: ['Second answer.'] }] },
      { gate: () => held },
    );
    const tts = new FakeTts();
    return { clock, transport, turns, tts, release: () => release() };
  }

  it('lets a quick one-word answer through as a turn of its own', async () => {
    const t = setup({
      stt: ['plan a trip', 'London'],
      message: [{ text: ['Paris or London?'] }, { text: ['London it is.'] }],
    });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    await feed({
      session: t.session,
      clock: t.clock,
      samples: Int16Array.from([...hum(900, 0.3, 1.7), ...quiet(900)]),
    });
    await t.session.settled();
    expect(t.turns.sent).toEqual(['plan a trip', 'London']);
  });

  it('does not stop the turn for a cough, or for "mm-hmm"', async () => {
    const g = gated();
    const session = new VoiceSession({
      transport: g.transport,
      vad: new LoudnessVad(),
      stt: new FakeStt('mm-hmm'),
      tts: g.tts,
      turns: g.turns,
      clock: g.clock,
    });
    session.start();
    await feed({ session, clock: g.clock, samples: says() });
    expect(g.turns.cancels).toBe(0);
    g.release();
    await session.settled();
    expect(g.turns.cancels).toBe(0);
  });

  it('never speaks the reply of a turn the person talked over, and starts the new one', async () => {
    const g = gated();
    const session = new VoiceSession({
      transport: g.transport,
      vad: new LoudnessVad(),
      stt: new FakeStt('first question', 'second question'),
      tts: g.tts,
      turns: g.turns,
      clock: g.clock,
    });
    session.start();
    await feed({ session, clock: g.clock, samples: says() });
    await feed({ session, clock: g.clock, samples: says() });
    g.release();
    await session.settled();
    expect(g.tts.sentences).not.toContain('First answer.');
    expect(g.turns.sent).toEqual(['first question', 'second question']);
  });
});

describe('ending a conversation', () => {
  it('cancels nothing when it never started a turn: a typed turn in the chat is left alone', async () => {
    const t = setup({});
    await t.session.end();
    expect(t.turns.cancels).toBe(0);
    expect(t.transport.closed).toBe(true);
  });

  it('ends after two minutes without the person speaking, and says why', async () => {
    const t = setup({});
    t.clock.advance(2 * 60_000 + 1);
    await t.session.settled();
    expect(t.transport.closed).toBe(true);
    expect(t.transport.events).toContainEqual({ type: 'notice', text: expect.stringContaining('quiet for a while') });
  });

  it('does not end while the person keeps talking, until the hard limit of thirty minutes', async () => {
    const t = setup({ stt: ['hello', 'hello'] });
    await feed({ session: t.session, clock: t.clock, samples: Int16Array.from([...hum(900), ...quiet(900)]) });
    t.clock.advance(100_000);
    await feed({ session: t.session, clock: t.clock, samples: hum(500) });
    expect(t.transport.closed).toBe(false);
    t.clock.advance(30 * 60_000);
    await t.session.settled();
    expect(t.transport.closed).toBe(true);
    expect(t.transport.events).toContainEqual({ type: 'notice', text: expect.stringContaining('long conversation') });
  });

  it('closes a line whose audio arrives faster than it can be listened to', async () => {
    const t = setup({});
    for (let n = 0; n < 200; n += 1) {
      t.session.pushAudio(pcmBytes(hum(32)));
    }
    await t.session.settled();
    expect(t.notes).toContain('backlog');
    expect(t.transport.closed).toBe(true);
  });
});
