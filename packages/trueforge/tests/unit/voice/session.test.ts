import { APPROVAL_LINES } from '../../../src/voice/approvalVoice';
import type { OutputFormat } from '../../../src/voice/audio';
import { IDLE_END_MS, VoiceSession, type TurnLatency } from '../../../src/voice/session';
import type { SpeechProbability } from '../../../src/voice/vad/sileroVad';
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
  stt: sttAnswers = [],
  message = [],
  approval: approvalReplies = [],
  outputFormat = 'pcm16',
  speechFailsOn,
  speechSilentOn,
  gate,
  holdAfterText,
  speechChanges,
  speechCannotCheck,
  speechUnchecked,
  speechDelay,
  vad = new LoudnessVad(),
  onNote,
}: {
  voiceApprovals?: boolean;
  stt?: string[];
  message?: ScriptedReply[];
  approval?: ScriptedReply[];
  outputFormat?: OutputFormat;
  speechFailsOn?: (text: string) => boolean;
  speechSilentOn?: (text: string) => boolean;
  gate?: () => Promise<void>;
  holdAfterText?: () => Promise<void>;
  speechChanges?: (text: string) => boolean;
  speechCannotCheck?: boolean;
  speechUnchecked?: boolean;
  speechDelay?: (text: string) => Promise<void>;
  vad?: SpeechProbability;
  onNote?: (note: string) => void;
}) {
  const clock = new ManualClock();
  const transport = new FakeTransport({ clock, voiceApprovals, outputFormat });
  const stt = new FakeStt(...sttAnswers);
  const tts = new FakeTts({
    failOn: speechFailsOn,
    silentOn: speechSilentOn,
    changes: speechChanges,
    cannotCheck: speechCannotCheck,
    unchecked: speechUnchecked,
    delay: speechDelay,
  });
  const turns = new FakeTurns({ message, approval: approvalReplies }, { gate, holdAfterText });
  const notes: string[] = [];
  const latencies: TurnLatency[] = [];
  const session = new VoiceSession({
    transport,
    vad,
    stt,
    tts,
    turns,
    clock,
    onNote: note => {
      notes.push(note);
      onNote?.(note);
    },
    onLatency: latency => latencies.push(latency),
  });
  session.start();
  return { session, transport, tts, stt, turns, clock, notes, latencies };
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

  it('tells the line once that a reply could not be spoken, so a caller can act on a line with no audio', async () => {
    const t = setup({
      stt: ['what is on my calendar'],
      message: [{ text: ['You have two meetings. ', 'The first is at nine.'] }],
      speechFailsOn: () => true,
    });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.transport.audio).toEqual([]);
    expect(t.transport.events.filter(event => event.type === 'tts_failed')).toEqual([{ type: 'tts_failed' }]);
    expect(t.notes).toContain('tts_failed:Error');
  });

  it('does not report a failure when the reply was spoken', async () => {
    const t = setup({ stt: ['hello'], message: [{ text: ['Hi there.'] }] });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.transport.events.some(event => event.type === 'tts_failed')).toBe(false);
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
      [
        "I'll send this reply to 1 address.",
        'The sending account is me at example dot com, on Gmail.',
        'To victor at example dot com, named Victor',
        'The subject is: Re: Thursday',
        'It says: Thursday at three works for me. See you then.',
      ].join('\n'),
      "Say 'yes, send it' to send, or 'no'.",
    ]);
  });

  it('reads a calendar event with its time and description, and a schedule with its task', async () => {
    const event = await readBack({ message: withCard(dentistCard) });
    const eventSpeech = event.tts.sentences.join(' ');
    expect(eventSpeech).toContain('Friday at 9, UTC time, for 1 hour');
    expect(eventSpeech).toContain('The title is: Dentist');
    expect(eventSpeech).toContain('the calendar of me at example dot com');
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

  it('asks for the phrase that matches the card: delete, and approve, are not interchangeable with send', async () => {
    const cancel = await readBack({
      message: withCard(cancelScheduleCard),
      stt: ['yes send it', 'yes, delete it'],
      approval: [{}],
    });
    await feed({ session: cancel.session, clock: cancel.clock, samples: says() });
    await cancel.session.settled();
    expect(cancel.tts.sentences).toContain("Say 'yes, delete it' to delete it, or 'no'.");
    expect(cancel.turns.answers).toEqual([]);
    await feed({ session: cancel.session, clock: cancel.clock, samples: quiet(6000) });
    await feed({ session: cancel.session, clock: cancel.clock, samples: says() });
    await cancel.session.settled();
    expect(cancel.turns.answers).toEqual([{ decision: 'allow', toolCallId: 'call-1' }]);

    const plain = await readBack({ message: withCard(dentistCard), stt: ['yes, approve'], approval: [{}] });
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

  it('leaves a file-write card (tier 2) for the screen', async () => {
    const t = await readBack({
      message: [{ text: ['I will write the file.'], approvals: [approval(calendarCard, 2)] }],
      stt: ['yes approve'],
    });
    expect(t.tts.sentences.at(-1)).toBe("I've left it in the app for you to approve.");
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.turns.answers).toEqual([]);
  });

  it.each([
    ['fails to be spoken', { speechFailsOn: (text: string) => text.includes('It says') }],
    ['makes no sound', { speechSilentOn: (text: string) => text.includes('It says') }],
  ])('does not take a "yes" when a body sentence of the read-back %s', async (_name, broken) => {
    const t = setup({ stt: ['send the reply', 'yes send it'], message: withCard(), ...broken });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    await feed({ session: t.session, clock: t.clock, samples: quiet(9000) });
    await t.session.settled();
    expect(t.tts.sentences.at(-1)).toBe("I've left it in the app for you to approve.");
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.turns.answers).toEqual([]);
  });

  it.each([
    [
      'would say a word differently',
      { speechChanges: (text: string) => text.includes('It says') },
      APPROVAL_LINES.cannotReadExactly,
    ],
    ['cannot be asked', { speechCannotCheck: true }, APPROVAL_LINES.leftForTheApp],
  ])(
    'reads none of the card when the voice %s, says it is left in the app, and takes no "yes"',
    async (_name, check, line) => {
      const t = setup({ stt: ['send the reply', 'yes send it'], message: withCard(), ...check });
      await feed({ session: t.session, clock: t.clock, samples: says() });
      await t.session.settled();
      await feed({ session: t.session, clock: t.clock, samples: quiet(9000) });
      await t.session.settled();
      expect(t.tts.sentences.join('\n')).not.toContain('Say ');
      // The opening line is part of the same text, so none of it is heard.
      expect(t.tts.sentences.join('\n')).not.toContain("I'll send");
      expect(t.tts.sentences).toEqual(['I have a draft.', line]);
      await feed({ session: t.session, clock: t.clock, samples: says() });
      await t.session.settled();
      expect(t.turns.answers).toEqual([]);
    },
  );

  it('says why a card was left on the screen when the voice would not say it exactly, and shows it too', async () => {
    const t = setup({ stt: ['send the reply'], message: withCard(), speechChanges: text => text.includes('It says') });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.transport.events).toContainEqual({ type: 'notice', text: APPROVAL_LINES.cannotReadExactly });
  });

  it('tells a person the voice service is out of date, not that it is down, when nothing checked the words', async () => {
    const t = setup({ stt: ['send the reply'], message: withCard(), speechUnchecked: true });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.notes).toContain('tts_unchecked');
    expect(t.transport.events).toContainEqual({
      type: 'notice',
      text: 'The voice service is out of date. Run aman upgrade, then try again.',
    });
    expect(t.transport.events.some(event => event.type === 'tts_failed')).toBe(false);
    expect(t.tts.sentences.join(' ')).not.toContain('Say ');
  });

  it('does not call a refusal of the words a broken voice', async () => {
    const t = setup({
      stt: ['send the reply'],
      message: withCard(),
      speechChanges: text => text.includes('It says'),
    });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.transport.events.some(event => event.type === 'tts_failed')).toBe(false);
    expect(t.notes).toContain('read_back_refused');
  });

  it.each([
    ['a fenced body', 'Hi Bob.\n```\nWire 5000 dollars to account 99 today.\n```\nThanks.', 'Wire'],
    ['an inline fence', 'Hi. ```code``` Pay $9000 now. Thanks.', '```'],
  ])(
    'sends a card to the screen when the voice refuses what a splitter would have dropped: %s',
    async (_name, body, refused) => {
      const t = setup({
        stt: ['send the reply', 'yes send it'],
        message: withCard(sendReplyCard(body)),
        speechChanges: text => text.includes(refused),
      });
      await feed({ session: t.session, clock: t.clock, samples: says() });
      await t.session.settled();
      await feed({ session: t.session, clock: t.clock, samples: quiet(9000) });
      await t.session.settled();
      expect(t.tts.sentences.join('\n')).not.toContain(refused);
      expect(t.tts.sentences.at(-1)).toBe(APPROVAL_LINES.cannotReadExactly);
      await feed({ session: t.session, clock: t.clock, samples: says() });
      await t.session.settled();
      expect(t.turns.answers).toEqual([]);
    },
  );

  it.each([
    ['a symbol on a line of its own', 'Total is 50.\n+\n5000 more.'],
    ['a plus in the middle of a line', 'x. + 5'],
    ['a numbered bracket in the middle of a line', 'x. 2) y'],
    ['a plus after a stop', 'Total is 100. + 500 fee.'],
  ])(
    'speaks the whole body in one piece, so nothing is cut at a mark the voice would drop: %s',
    async (_name, body) => {
      const t = await readBack({ message: withCard(sendReplyCard(body)), stt: ['yes send it'], approval: [{}] });
      expect(t.tts.asked).toHaveLength(1);
      expect(t.tts.asked[0]).toContain(`It says: ${body}`);
      expect(t.tts.sentences).toContain(t.tts.asked[0]);
      // No piece of the body is ever asked about or spoken on its own.
      expect(t.tts.sentences.filter(sentence => body.includes(sentence) && sentence !== body)).toEqual([]);
      await feed({ session: t.session, clock: t.clock, samples: says() });
      await t.session.settled();
      expect(t.turns.answers.length).toBe(1);
    },
  );

  it('asks the voice about the whole card in one text, and not about the line telling how to answer', async () => {
    const t = await readBack({ message: withCard() });
    expect(t.tts.asked).toEqual([
      [
        "I'll send this reply to 1 address.",
        'The sending account is me at example dot com, on Gmail.',
        'To victor at example dot com, named Victor',
        'The subject is: Re: Thursday',
        'It says: Thursday at three works for me. See you then.',
      ].join('\n'),
    ]);
  });

  it('puts a number the voice would say differently on the screen, so a sum is only approved when heard as written', async () => {
    const t = setup({
      stt: ['send the reply'],
      message: withCard(sendReplyCard('Confirmed. 5000. Dollars is fine, wire $1,5 today.')),
      speechChanges: text => text.includes('$1,5'),
    });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.tts.sentences.join(' ')).not.toContain('5000');
    expect(t.tts.sentences.at(-1)).toBe(APPROVAL_LINES.cannotReadExactly);
  });

  it('says on the screen that it could not read the card when even the spoken line fails', async () => {
    const t = setup({
      stt: ['send the reply'],
      message: withCard(),
      speechFailsOn: () => true,
    });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.transport.events).toContainEqual({
      type: 'notice',
      text: 'I could not read all of that out loud, so it is waiting on the screen. Answer it there.',
    });
  });

  it('stops "I missed that" when talked over, and keeps a waiting card answerable', async () => {
    const t = await readBack({ message: withCard() });
    const latenciesBefore = t.latencies.length;
    t.stt.hold = true;
    for (let n = 0; n < 2; n += 1) {
      await feed({ session: t.session, clock: t.clock, samples: says() });
    }
    // The third is dropped just as its silence ends, so the line is still playing when the person speaks again.
    await feed({ session: t.session, clock: t.clock, samples: says(900, 700) });
    expect(t.tts.sentences.at(-1)).toBe('I missed that. Please say it again.');
    // The line is not a reply, so it reports no reply timings.
    expect(t.latencies.length).toBe(latenciesBefore);
    // Talking over the line stops it at once.
    const clearedBefore = t.transport.cleared;
    await feed({ session: t.session, clock: t.clock, samples: hum(700, 0.3, 1.7) });
    expect(t.transport.cleared).toBeGreaterThan(clearedBefore);
    expect(t.tts.signals.get('I missed that. Please say it again.')?.aborted).toBe(true);
    // The card was not read over, so the answer still settles it.
    t.stt.hold = false;
    t.stt.release('yes send it');
    await t.session.settled();
    expect(t.turns.answers.length).toBe(1);
    await t.session.end();
  });

  /**
   * The card's body is made and played out, while the line telling how to answer, and the "I missed that"
   * line if one is wanted, are each held until released: the order they reach the line decides the race.
   */
  async function withLinesHeld(later: string[] = []) {
    const gates: { instruction: () => void; missed: () => void } = {
      instruction: () => undefined,
      missed: () => undefined,
    };
    const held = {
      instruction: new Promise<void>(resolve => {
        gates.instruction = resolve;
      }),
      missed: new Promise<void>(resolve => {
        gates.missed = resolve;
      }),
    };
    const t = setup({
      stt: ['send the reply', ...later],
      message: withCard(),
      speechDelay: text =>
        text.startsWith("Say '")
          ? held.instruction
          : text.startsWith('I missed that')
            ? held.missed
            : Promise.resolve(),
    });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await feed({ session: t.session, clock: t.clock, samples: quiet(3000) });
    return { t, releaseInstruction: gates.instruction, releaseMissed: gates.missed };
  }

  /** Three words spoken while the transcriber is busy, so the third is dropped and "I missed that" is wanted. */
  async function overflowTheTranscriber(t: Awaited<ReturnType<typeof withLinesHeld>>['t']) {
    t.stt.hold = true;
    for (let n = 0; n < 2; n += 1) {
      await feed({ session: t.session, clock: t.clock, samples: says() });
    }
    await feed({ session: t.session, clock: t.clock, samples: says(900, 700) });
  }

  it('does not take as an answer what was said before the card was read out, even when it is written down late', async () => {
    const { t, releaseInstruction } = await withLinesHeld(['yes send it']);
    t.stt.hold = true;
    await feed({ session: t.session, clock: t.clock, samples: says() });
    releaseInstruction();
    await feed({ session: t.session, clock: t.clock, samples: quiet(3000) });
    t.stt.hold = false;
    t.stt.release('yes send it');
    await t.session.settled();
    expect(t.turns.answers).toEqual([]);
    expect(t.notes).toContain('speech_before_card');
    // It gets the reminder, and the card keeps waiting: said again after the read-back, the phrase works.
    expect(t.tts.sentences.at(-1)).toContain('still waiting for your answer');
    expect(t.turns.sent).toEqual(['send the reply']);
    await feed({ session: t.session, clock: t.clock, samples: quiet(6000) });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.turns.answers).toEqual([{ decision: 'allow', toolCallId: 'call-1' }]);
  });

  it('keeps a read-back that was cut off unanswerable when "I missed that" is queued after its last line', async () => {
    const { t, releaseInstruction, releaseMissed } = await withLinesHeld(['yes send it']);
    await overflowTheTranscriber(t);
    // The line telling how to answer reaches the line first, then the missed line is queued behind it.
    releaseInstruction();
    await feed({ session: t.session, clock: t.clock, samples: quiet(64) });
    releaseMissed();
    await feed({ session: t.session, clock: t.clock, samples: quiet(64) });
    expect(t.tts.sentences.at(-1)).toBe('I missed that. Please say it again.');
    // The person talks over the instruction line, which was not heard through.
    await feed({ session: t.session, clock: t.clock, samples: hum(700, 0.3, 1.7) });
    // What was held comes back as filler, so it cannot be the reason the card is not answered.
    t.stt.hold = false;
    t.stt.release('hmm');
    await t.session.settled();
    // Well after the card would have been waiting, the exact phrase is said.
    await feed({ session: t.session, clock: t.clock, samples: quiet(6000) });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.turns.answers).toEqual([]);
    expect(t.turns.sent).toEqual(['send the reply', 'yes send it']);
    await t.session.end();
  });

  it('keeps a read-back that was cut off unanswerable when "I missed that" is queued before its last line', async () => {
    const { t, releaseInstruction, releaseMissed } = await withLinesHeld();
    await overflowTheTranscriber(t);
    releaseMissed();
    await feed({ session: t.session, clock: t.clock, samples: quiet(64) });
    releaseInstruction();
    await feed({ session: t.session, clock: t.clock, samples: quiet(64) });
    await feed({ session: t.session, clock: t.clock, samples: hum(700, 0.3, 1.7) });
    t.stt.hold = false;
    t.stt.release('yes send it');
    await t.session.settled();
    expect(t.turns.answers).toEqual([]);
    await t.session.end();
  });

  it('tells the screen when the person cut off a card before it could be waited on', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const t = setup({
      stt: ['send the reply'],
      message: withCard(),
      speechDelay: text => (text.startsWith("Say '") ? held : Promise.resolve()),
    });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    // The body is still playing when the person talks over it, so the held line is stopped.
    await feed({ session: t.session, clock: t.clock, samples: hum(700, 0.3, 1.7) });
    release();
    await feed({ session: t.session, clock: t.clock, samples: quiet(64) });
    await t.session.settled();
    expect(t.turns.answers).toEqual([]);
    expect(t.transport.events).toContainEqual({
      type: 'notice',
      text: 'I stopped reading that card. It is waiting on the screen. Answer it there.',
    });
  });

  it('does not take a "yes" for a card that was already answered on the screen, and treats it as a new turn', async () => {
    const t = await readBack({ message: withCard(), stt: ['yes send it'], approval: [] });
    t.turns.settledElsewhere.add('call-1');
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await t.session.settled();
    expect(t.turns.answers).toEqual([]);
    expect(t.turns.sent).toEqual(['send the reply', 'yes send it']);
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
    expect(t.tts.sentences.at(-1)).toBe('Wait a moment, then say that again.');
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

  it('closes a line when listening cannot keep up with the microphone', async () => {
    const stuck: SpeechProbability = {
      probability: () => new Promise<number>(() => undefined),
      reset: () => undefined,
    };
    const t = setup({ vad: stuck });
    for (let n = 0; n < 200 && !t.transport.closed; n += 1) {
      t.session.pushAudio(pcmBytes(hum(32)));
      t.clock.advance(32);
    }
    expect(t.notes).toContain('backlog');
    expect(t.transport.closed).toBe(true);
  });

  it('listens to one whole 64 KB frame without giving up', async () => {
    const t = setup({});
    t.session.pushAudio(pcmBytes(quiet(2048)));
    await t.session.settled();
    expect(t.transport.closed).toBe(false);
    expect(t.notes).not.toContain('backlog');
  });

  it('closes a line that sends audio faster than real time, even when each piece is listened to in time', async () => {
    const t = setup({});
    for (let n = 0; n < 400; n += 1) {
      t.session.pushAudio(pcmBytes(quiet(32)));
      await t.session.settled();
    }
    expect(t.notes).toContain('faster_than_real_time');
    expect(t.transport.closed).toBe(true);
    expect(t.transport.events).toContainEqual({ type: 'notice', text: expect.stringContaining('keep up') });
  });

  it('allows a short burst, as a slow network delivers', async () => {
    const t = setup({});
    for (let n = 0; n < 60; n += 1) {
      t.session.pushAudio(pcmBytes(quiet(32)));
      await t.session.settled();
    }
    expect(t.transport.closed).toBe(false);
  });

  it('listens to a few utterances at once at most and ignores the rest', async () => {
    const t = setup({ stt: [] });
    t.stt.hold = true;
    for (let n = 0; n < 5; n += 1) {
      await feed({ session: t.session, clock: t.clock, samples: says() });
    }
    expect(t.stt.calls).toBe(2);
    expect(t.notes).toContain('stt_busy');
    await t.session.end();
  });

  it('says so out loud when it has to drop an utterance, never silently', async () => {
    const t = setup({ stt: [] });
    t.stt.hold = true;
    for (let n = 0; n < 3; n += 1) {
      await feed({ session: t.session, clock: t.clock, samples: says() });
    }
    expect(t.transport.events).toContainEqual({ type: 'notice', text: 'I missed that. Please say it again.' });
    await t.session.end();
  });

  it('speaks "I missed that" through the voice when nothing is playing, as well as showing it', async () => {
    const t = setup({ stt: [] });
    t.stt.hold = true;
    for (let n = 0; n < 3; n += 1) {
      await feed({ session: t.session, clock: t.clock, samples: says() });
    }
    await feed({ session: t.session, clock: t.clock, samples: quiet(1600) });
    expect(t.tts.sentences).toEqual(['I missed that. Please say it again.']);
    expect(t.transport.audio.length).toBeGreaterThan(0);
    await t.session.end();
  });

  it('does not count an utterance that is understood and only waits its turn, so a quick "no" is still heard', async () => {
    const finish: ((text: string) => void)[] = [];
    let calls = 0;
    const stt = {
      transcribe: (): Promise<string> => {
        calls += 1;
        if (calls === 1) {
          return new Promise<string>(resolve => {
            finish.push(resolve);
          });
        }
        return Promise.resolve(calls === 2 ? 'second thing' : 'no');
      },
    };
    const t = setup({ message: [{ text: ['One.'] }, { text: ['Two.'] }, { text: ['Three.'] }] });
    const session = new VoiceSession({
      transport: t.transport,
      vad: new LoudnessVad(),
      stt,
      tts: t.tts,
      turns: t.turns,
      clock: t.clock,
    });
    session.start();
    // The first is slow, the second is understood at once but must wait for it, and a third follows.
    await feed({ session, clock: t.clock, samples: says() });
    await feed({ session, clock: t.clock, samples: says() });
    await feed({ session, clock: t.clock, samples: says() });
    expect(calls).toBe(3);
    expect(t.notes).not.toContain('stt_busy');
    finish[0]?.('first thing');
    await session.settled();
    expect(t.turns.sent).toEqual(['first thing', 'second thing', 'no']);
  });

  it('cannot be fed quiet time to spend later: a burst after a long pause is refused', async () => {
    const t = setup({});
    t.clock.advance(60_000);
    for (let n = 0; n < 400 && !t.transport.closed; n += 1) {
      t.session.pushAudio(pcmBytes(quiet(32)));
      await t.session.settled();
    }
    expect(t.notes).toContain('faster_than_real_time');
    expect(t.transport.closed).toBe(true);
  });
});

describe('a long turn, noises and order', () => {
  function heldTurn() {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    return { gate: () => held, release: () => release() };
  }

  it('does not end the conversation while a turn runs for longer than the quiet time', async () => {
    const turn = heldTurn();
    const t = setup({ stt: ['a big question'], message: [{ text: ['Here you go.'] }], gate: turn.gate });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    t.clock.advance(IDLE_END_MS + 5000);
    expect(t.transport.closed).toBe(false);
    turn.release();
    await t.session.settled();
    expect(t.tts.sentences).toEqual(['Here you go.']);
    expect(t.transport.closed).toBe(false);
    // Quiet is counted again once the reply has been heard.
    t.clock.advance(3000);
    t.clock.advance(IDLE_END_MS + 5000);
    expect(t.transport.closed).toBe(true);
  });

  it('does not start the quiet clock when the person cuts a reply short while its turn is still running', async () => {
    const turn = heldTurn();
    const t = setup({
      stt: ['tell me a story', ''],
      message: [{ text: ['Once upon a time. ', 'There was a fox. ', 'It was clever.'] }],
      holdAfterText: turn.gate,
    });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await feed({ session: t.session, clock: t.clock, samples: hum(700, 0.3, 1.7) });
    expect(t.notes).toContain('barge_in');
    expect(t.transport.states().at(-1)).toBe('thinking');
    t.clock.advance(IDLE_END_MS + 5000);
    expect(t.transport.closed).toBe(false);
    turn.release();
    await t.session.settled();
  });

  it('keeps speaking the reply when a noise while it was being worked on turns out to be nothing', async () => {
    const turn = heldTurn();
    const t = setup({ stt: ['what time is it', ''], message: [{ text: ['It is nine.'] }], gate: turn.gate });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await feed({
      session: t.session,
      clock: t.clock,
      samples: Int16Array.from([...hum(400, 0.3, 3.1), ...quiet(900)]),
    });
    turn.release();
    await t.session.settled();
    expect(t.tts.sentences).toEqual(['It is nine.']);
    expect(t.turns.cancels).toBe(0);
  });

  it('takes words in the order they were spoken when a short one is understood before a long one', async () => {
    let finishFirst: (text: string) => void = () => undefined;
    let calls = 0;
    const slowThenFast = {
      transcribe: (): Promise<string> => {
        calls += 1;
        if (calls === 1) {
          return new Promise<string>(resolve => {
            finishFirst = resolve;
          });
        }
        return Promise.resolve('second thing');
      },
    };
    const t = setup({ message: [{ text: ['One.'] }, { text: ['Two.'] }] });
    const session = new VoiceSession({
      transport: t.transport,
      vad: new LoudnessVad(),
      stt: slowThenFast,
      tts: t.tts,
      turns: t.turns,
      clock: t.clock,
    });
    session.start();
    await feed({ session, clock: t.clock, samples: says() });
    await feed({ session, clock: t.clock, samples: says() });
    expect(t.turns.sent).toEqual([]);
    finishFirst('first thing');
    await session.settled();
    expect(t.turns.sent).toEqual(['first thing', 'second thing']);
  });

  it('does not wake up again after the conversation ended while a window was being listened to', async () => {
    let release: (probability: number) => void = () => undefined;
    const pending = new Promise<number>(resolve => {
      release = resolve;
    });
    const slowVad: SpeechProbability = { probability: () => pending, reset: () => undefined };
    const t = setup({ vad: slowVad });
    for (let n = 0; n < 12; n += 1) {
      t.session.pushAudio(pcmBytes(hum(32)));
    }
    await t.session.end();
    release(0.95);
    await t.session.settled();
    const before = t.transport.events.length;
    t.clock.advance(IDLE_END_MS * 2);
    expect(t.transport.events.length).toBe(before);
  });

  it('keeps going when handling one transcript throws', async () => {
    const t = setup({
      stt: ['hmm'],
      onNote: note => {
        if (note === 'filler_ignored') {
          throw new Error('boom');
        }
      },
    });
    await feed({ session: t.session, clock: t.clock, samples: says() });
    await expect(t.session.settled()).resolves.toBeUndefined();
    expect(t.notes.some(note => note.startsWith('accept_failed'))).toBe(true);
  });
});
