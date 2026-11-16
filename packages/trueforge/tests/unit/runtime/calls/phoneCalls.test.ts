import { createHash } from 'node:crypto';

import { CALL_LINES } from '../../../../src/runtime/calls/callTurns';
import { CALLS_NEED_VOICE, CALLS_VOICE_OUT_OF_DATE } from '../../../../src/runtime/calls/callVoiceReady';
import { readReachHistory } from '../../../../src/runtime/noticing/reachGate';
import { SidecarSpeechSynthesizer, ttsBaseUrl } from '../../../../src/voice/ttsClient';
import { ACCOUNT_SID, ALICE, CALL_SID, PHONE, callsHarness } from '../../../fixtures/callsHarness';
import { FakeStt, FakeTts, FakeTurns, LoudnessVad, hum, mulawBytes, quiet } from '../../../fixtures/voice/fakes';

type Harness = Awaited<ReturnType<typeof callsHarness>>;

const OTHER_SID = `CA${'c'.repeat(32)}`;

const pause = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/** Sends sound down the line the way Twilio does: 8 kHz frames of 20 ms, in real time. */
async function sendSound(media: { socket: { send: (data: string) => void } }, samples: Int16Array): Promise<void> {
  const phone = samples.filter((_, index) => index % 2 === 0);
  for (let offset = 0; offset < phone.length; offset += 160) {
    media.socket.send(
      JSON.stringify({
        event: 'media',
        streamSid: 'MZ1',
        media: { payload: Buffer.from(mulawBytes(phone.subarray(offset, offset + 160))).toString('base64') },
      }),
    );
    await pause(20);
  }
}

/** A call row whose Twilio id was never saved, as when saving it failed or Twilio answered slowly. */
async function callWithoutSid(h: Harness) {
  const delivery = await h.deliveries.deliver({
    ...ALICE,
    kind: 'nudge',
    level: 'call',
    text: 'Your 3pm clashes.',
    reason: 'Two things at once.',
    link: null,
    // Only the app channel is tried, so no call goes out for this row.
    test: 'in_app',
  });
  const call = await h.calls.create({
    id: 'call-unsaved',
    ...ALICE,
    delivery_id: delivery.id,
    fallback: true,
    now: h.clock.now,
    expires_at: new Date(h.clock.now.getTime() + 5 * 60_000),
  });
  return { delivery, call };
}

describe('phone calls as a channel of the delivery layer', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it('calls no one on a new install: no settings, no number, the phone never rings', async () => {
    h = await callsHarness();
    const delivery = await h.callDelivery();
    expect(h.placed).toEqual([]);
    expect(h.texts).toEqual([]);
    expect(delivery.attempts.find(attempt => attempt.channel === 'call')?.outcome).toBe('skipped');
  });

  it('rings the confirmed number once, records it as a call attempt, and sends no push or text while it rings', async () => {
    h = await callsHarness();
    await h.readyToCall();
    const delivery = await h.callDelivery();
    expect(h.placed).toEqual([{ to: PHONE, call_id: expect.any(String) }]);
    expect(delivery.attempts.map(attempt => [attempt.channel, attempt.outcome])).toEqual([
      ['in_app', 'sent'],
      ['call', 'sent'],
    ]);
    expect(delivery.attempts[1]?.target).toBe('number ending 0111');
    expect(h.pushes).toEqual([]);
    expect(h.texts).toEqual([]);
    expect(h.activity.map(row => row.tool_name)).toContain('delivery.call');
  });

  it('rings only the confirmed number, never a new number still waiting for its code', async () => {
    h = await callsHarness();
    await h.readyToCall({ pending: '+15550199' });
    await h.callDelivery();
    expect(h.placed.map(call => call.to)).toEqual([PHONE]);
  });

  it('never rings a number that replied STOP, and falls back to a push at once', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.contacts.optOut({ phone: PHONE, now: h.clock.now });
    const delivery = await h.callDelivery();
    expect(h.placed).toEqual([]);
    expect(h.texts).toEqual([]);
    expect(h.pushes).toEqual([delivery.id]);
  });

  it('counts a call toward the time between calls even when no one answered', async () => {
    h = await callsHarness();
    await h.readyToCall();
    const delivery = await h.callDelivery();
    await h.status('no-answer');
    await h.waitFor(() => h.pushes.length > 0);
    expect(h.telegrams).toEqual([delivery.id]);
    const history = await readReachHistory({
      history: h.deliveryStore,
      owner: ALICE,
      timezone: 'UTC',
      now: h.clock.now,
    });
    expect(history.last_call_at?.toISOString()).toBe(delivery.created_at);
  });

  it('does not call a number that is not confirmed, and falls back to a push at once, after saying why', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.contacts.remove(ALICE);
    const delivery = await h.callDelivery();
    expect(h.placed).toEqual([]);
    expect((await h.attemptsOf(delivery.id)).map(attempt => [attempt.channel, attempt.outcome])).toEqual([
      ['in_app', 'sent'],
      ['call', 'skipped'],
      ['web_push', 'sent'],
      ['sms', 'skipped'],
    ]);
    expect(h.pushes).toEqual([delivery.id]);
    expect(h.telegrams).toEqual([delivery.id]);
  });

  it('does not ring while the voice parts are not running, says so, and sends a text and a push instead', async () => {
    let ready = false;
    h = await callsHarness({ voice: () => (ready ? 'ready' : 'not_running') });
    await h.readyToCall();
    const delivery = await h.callDelivery();
    expect(h.placed).toEqual([]);
    const call = (await h.attemptsOf(delivery.id)).find(attempt => attempt.channel === 'call');
    expect(call).toMatchObject({ outcome: 'skipped', detail: CALLS_NEED_VOICE });
    expect(h.texts).toHaveLength(1);
    expect(h.pushes).toEqual([delivery.id]);
  });

  it('says the voice service is out of date, not just stopped, when it is too old to check', async () => {
    h = await callsHarness({ voice: 'out_of_date' });
    await h.readyToCall();
    const delivery = await h.callDelivery();
    expect(h.placed).toEqual([]);
    const call = (await h.attemptsOf(delivery.id)).find(attempt => attempt.channel === 'call');
    expect(call).toMatchObject({ outcome: 'skipped', detail: CALLS_VOICE_OUT_OF_DATE });
  });

  it('when no one answers, leaves one text and one push, and never calls again', async () => {
    h = await callsHarness();
    await h.readyToCall();
    const delivery = await h.callDelivery();
    expect((await h.status('no-answer')).status).toBe(200);
    // Twilio may tell us twice; nothing happens twice.
    await h.status('no-answer');
    await h.status('completed');
    expect(h.placed).toHaveLength(1);
    expect(h.texts).toHaveLength(1);
    expect(h.texts[0]?.body).toBe('Mannie: something needs you. Open the app to see it.');
    expect(h.pushes).toEqual([delivery.id]);
    const attempts = await h.attemptsOf(delivery.id);
    expect(attempts.filter(attempt => attempt.channel === 'call').map(attempt => attempt.outcome)).toEqual([
      'sent',
      'failed',
    ]);
    expect(attempts.find(attempt => attempt.outcome === 'failed')?.detail).toBe(
      'No one answered. It was sent as a text and a notice instead.',
    );
    expect((await h.calls.getBySid(CALL_SID))?.outcome).toBe('no_answer');
  });

  it('stops the voicemail’s voice when the line drops while it is being made', async () => {
    let reached: () => void = () => undefined;
    const making = new Promise<void>(resolve => {
      reached = resolve;
    });
    const tts = new FakeTts({
      delay: () => {
        reached();
        return new Promise<void>(() => undefined);
      },
    });
    h = await callsHarness({ tts });
    await h.readyToCall();
    await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer('machine_end_beep')).token });
    await making;
    const text = 'This is Mannie. Something needs you. Please open the app.';
    expect(tts.signals.get(text)?.aborted).toBe(false);
    media.socket.close();
    await h.waitFor(() => tts.signals.get(text)?.aborted === true);
  });

  it('on a voicemail, leaves one short message in the assistant’s own voice, then one text and one push', async () => {
    h = await callsHarness();
    await h.readyToCall();
    const delivery = await h.callDelivery('Your bill of $482.10 from Northwind Power is due Friday.');
    const { twiml, token } = await h.answer('machine_end_beep');
    expect(twiml).toContain(
      `<Connect><Stream url="wss://aman.example.invalid/twilio/media/${h.placed.at(-1)?.call_id ?? ''}">`,
    );
    expect(twiml).not.toContain('<Say');
    const media = await h.openMedia({ token });
    expect(await media.closed).toBe(1000);
    await h.waitFor(() => h.texts.length === 1 && h.pushes.length === 1);
    expect(h.tts.sentences.join(' ')).toBe('This is Mannie. Something needs you. Please open the app.');
    expect(media.frames.some(frame => frame.event === 'media')).toBe(true);
    expect((await h.calls.getBySid(CALL_SID))?.outcome).toBe('voicemail');
    await h.status('completed');
    expect(h.texts).toHaveLength(1);
    expect(h.texts[0]?.body).not.toContain('482');
    expect(h.pushes).toEqual([delivery.id]);
    expect(h.placed).toHaveLength(1);
    const calls = (await h.attemptsOf(delivery.id)).filter(attempt => attempt.channel === 'call');
    expect(calls.map(attempt => attempt.outcome)).toEqual(['sent', 'sent']);
    expect(calls[1]?.detail).toContain('A voicemail picked up, so a short message was left.');
  });

  it('when a voicemail could not be spoken, still sends one text and one push, and says no message was left', async () => {
    h = await callsHarness({ tts: new FakeTts({ delay: () => Promise.reject(new Error('voice down')) }) });
    await h.readyToCall();
    const delivery = await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer('machine_end_beep')).token });
    await media.closed;
    await h.waitFor(() => h.texts.length === 1 && h.pushes.length === 1);
    const calls = (await h.attemptsOf(delivery.id)).filter(attempt => attempt.channel === 'call');
    expect(calls.at(-1)?.detail).toBe(
      'A voicemail picked up, but no message could be left. It was sent as a text and a notice instead.',
    );
  });

  it('leaves no voicemail when the voice would change a word of it, and still sends one text and one push', async () => {
    h = await callsHarness({ tts: new FakeTts({ changes: () => true }) });
    await h.readyToCall();
    const delivery = await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer('machine_end_beep')).token });
    await media.closed;
    await h.waitFor(() => h.texts.length === 1 && h.pushes.length === 1);
    expect(h.tts.sentences).toEqual([]);
    const calls = (await h.attemptsOf(delivery.id)).filter(attempt => attempt.channel === 'call');
    expect(calls.at(-1)?.detail).toBe(
      'A voicemail picked up, but no message could be left. It was sent as a text and a notice instead.',
    );
  });

  it('a test call never falls back to a text', async () => {
    h = await callsHarness();
    await h.readyToCall();
    const delivery = await h.deliveries.deliver({
      ...ALICE,
      kind: 'note',
      level: 'nudge',
      text: 'This is a test call.',
      reason: 'You pressed Try it.',
      link: null,
      test: 'call',
    });
    expect(delivery.attempts.find(attempt => attempt.channel === 'call')?.outcome).toBe('sent');
    await h.status('busy');
    expect(h.texts).toEqual([]);
    expect(h.pushes).toEqual([]);
  });

  it('a second test call right after the first is turned away with words that say when to try again', async () => {
    h = await callsHarness();
    await h.readyToCall();
    const tryIt = () =>
      h.deliveries.deliver({
        ...ALICE,
        kind: 'note',
        level: 'nudge',
        text: 'This is a test call.',
        reason: 'You pressed Try it.',
        link: null,
        test: 'call',
      });
    expect((await tryIt()).attempts.find(attempt => attempt.channel === 'call')?.outcome).toBe('sent');
    const second = (await tryIt()).attempts.find(attempt => attempt.channel === 'call');
    expect(second?.outcome).toBe('skipped');
    expect(second?.detail).toMatch(/try again/i);
    expect(h.placed).toHaveLength(1);
  });

  it('a test call Twilio could not start says to try again, since nothing else was sent', async () => {
    h = await callsHarness();
    await h.readyToCall();
    h.nextCall.result = { outcome: 'failed', failure: 'unreachable' };
    const delivery = await h.deliveries.deliver({
      ...ALICE,
      kind: 'note',
      level: 'nudge',
      text: 'This is a test call.',
      reason: 'You pressed Try it.',
      link: null,
      test: 'call',
    });
    expect(delivery.attempts.find(attempt => attempt.channel === 'call')?.detail).toBe(
      'The call could not be started. Try again in 2 minutes.',
    );
    expect(h.texts).toEqual([]);
  });

  it('a test call that cannot ring yet does not use up a test', async () => {
    let ready = false;
    h = await callsHarness({ voice: () => (ready ? 'ready' : 'not_running') });
    await h.readyToCall();
    const tryIt = () =>
      h.deliveries.deliver({
        ...ALICE,
        kind: 'note',
        level: 'nudge',
        text: 'This is a test call.',
        reason: 'You pressed Try it.',
        link: null,
        test: 'call',
      });
    expect((await tryIt()).attempts.find(attempt => attempt.channel === 'call')?.outcome).toBe('skipped');
    ready = true;
    expect((await tryIt()).attempts.find(attempt => attempt.channel === 'call')?.outcome).toBe('sent');
    expect(h.placed).toHaveLength(1);
  });
});

describe('a call whose Twilio id was not saved', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it('still reports the call as ringing when saving Twilio’s id fails, and it still connects', async () => {
    h = await callsHarness();
    await h.readyToCall();
    jest.spyOn(h.calls, 'attachSid').mockRejectedValueOnce(new Error('database busy'));
    const delivery = await h.callDelivery();
    expect(delivery.attempts.find(attempt => attempt.channel === 'call')?.outcome).toBe('sent');
    expect(h.pushes).toEqual([]);
    // Twilio's own request names the call by Aman's id too.
    expect((await h.answer()).token).toBeDefined();
  });

  it('finds the call by its own id when Twilio says early that it failed, and falls back', async () => {
    h = await callsHarness();
    await h.readyToCall();
    const { delivery, call } = await callWithoutSid(h);
    await h.status('failed', { callSid: OTHER_SID, callId: call.id });
    await h.waitFor(() => h.pushes.length === 1);
    expect(h.pushes).toEqual([delivery.id]);
    expect((await h.calls.get(call.id))?.outcome).toBe('no_answer');
  });

  it('ignores a request whose call id names a call that already has another Twilio id', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    const callId = h.placed[0]?.call_id ?? '';
    const response = await h.twilioPost({
      path: `/twilio/voice?call=${callId}`,
      fields: { AccountSid: ACCOUNT_SID, CallSid: OTHER_SID, AnsweredBy: 'human' },
    });
    expect(await response.text()).toContain('<Hangup/>');
    expect((await h.calls.get(callId))?.call_sid).toBe(CALL_SID);
  });

  it('refuses another call’s valid key sent on this call’s address', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    await h.answer();
    // A second call of the same person, with its own Twilio id and a key that is good for it.
    const { call: other } = await callWithoutSid(h);
    await h.calls.attachSid({ id: other.id, call_sid: OTHER_SID });
    const otherKey = 'key-for-the-other-call';
    await h.db.updateTable('phone_call').set({ status: 'ringing' }).where('id', '=', other.id).execute();
    await h.calls.issueToken({
      call_sid: OTHER_SID,
      token_hash: createHash('sha256').update(otherKey, 'utf8').digest('hex'),
      token_expires_at: new Date(h.clock.now.getTime() + 30_000),
      mode: 'talk',
      now: h.clock.now,
    });
    const media = await h.openMedia({ token: otherKey, callSid: OTHER_SID });
    expect(await media.closed).toBe(1008);
    expect(h.tts.sentences).toEqual([]);
  });
});

describe('a call that ends while its line opens', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it('when Twilio says the call completed before the line opened, says so and sends a text and a push', async () => {
    h = await callsHarness();
    await h.readyToCall();
    const delivery = await h.callDelivery();
    await h.answer();
    await h.status('completed');
    await h.waitFor(() => h.pushes.length === 1);
    expect((await h.calls.getBySid(CALL_SID))?.outcome).toBe('failed');
    const calls = (await h.attemptsOf(delivery.id)).filter(attempt => attempt.channel === 'call');
    expect(calls.at(-1)?.detail).toBe(
      'The call was answered, but the line could not be opened. It was sent as a text and a notice instead.',
    );
  });

  it('when the parts that listen cannot load, closes the line and sends a text and a push', async () => {
    h = await callsHarness({ listening: () => Promise.reject(new Error('model missing')) });
    await h.readyToCall();
    const delivery = await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer()).token });
    expect(await media.closed).toBe(1011);
    await h.waitFor(() => h.texts.length === 1 && h.pushes.length === 1);
    expect((await h.calls.getBySid(CALL_SID))?.outcome).toBe('failed');
    expect(h.pushes).toEqual([delivery.id]);
    expect(h.tts.sentences).toEqual([]);
  });

  it('when the voice cannot speak the opening, hangs up and sends a text and a push instead', async () => {
    h = await callsHarness({ tts: new FakeTts({ failOn: () => true }) });
    await h.readyToCall();
    const delivery = await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer()).token });
    expect(await media.closed).toBe(1000);
    await h.waitFor(() => h.texts.length === 1 && h.pushes.length === 1);
    expect((await h.calls.getBySid(CALL_SID))?.outcome).toBe('failed');
    expect(h.pushes).toEqual([delivery.id]);
    const calls = (await h.attemptsOf(delivery.id)).filter(attempt => attempt.channel === 'call');
    expect(calls.at(-1)?.detail).toBe(
      'The call was answered, but the line could not be opened. It was sent as a text and a notice instead.',
    );
  });

  it('when the voice would change a word of the opening, says none of it and sends a text and a push instead', async () => {
    h = await callsHarness({ tts: new FakeTts({ changes: text => text.startsWith('Hi, this is') }) });
    await h.readyToCall();
    const delivery = await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer()).token });
    expect(await media.closed).toBe(1000);
    await h.waitFor(() => h.texts.length === 1 && h.pushes.length === 1);
    expect(h.tts.sentences).toEqual([]);
    expect((await h.calls.getBySid(CALL_SID))?.outcome).toBe('failed');
    expect(h.pushes).toEqual([delivery.id]);
  });

  /** Answers the opening with a yes, the way the person does on the phone. */
  async function sayYes(media: Awaited<ReturnType<Harness['openMedia']>>): Promise<void> {
    await h.waitFor(() => h.tts.sentences.length >= 1 && media.frames.some(frame => frame.event === 'mark'));
    // The fake line plays instantly, so wait out the opening's own length before answering.
    await pause(1700);
    await sendSound(media, Int16Array.from([...hum(600), ...quiet(900)]));
  }

  it('after a yes, speaks a message the voice would not say word for word, such as a time written for the screen', async () => {
    const begun: string[] = [];
    h = await callsHarness({
      // The way the voice service refuses "p.m." when asked to say a text exactly.
      tts: new FakeTts({ changes: text => text.includes('p.m.') }),
      chat: {
        turns: new FakeTurns({ message: [] }),
        begin: () => {
          begun.push('chat-1');
          return Promise.resolve('chat-1');
        },
      },
      listening: () => Promise.resolve({ vad: new LoudnessVad(), stt: new FakeStt('yes') }),
    });
    await h.readyToCall();
    const delivery = await h.callDelivery('Dentist at 2:30 p.m.');
    const media = await h.openMedia({ token: (await h.answer()).token });
    await sayYes(media);
    await h.waitFor(() => h.tts.sentences.join(' ').includes('Dentist at 2:30 p.m.'));
    await h.waitFor(() => begun.length === 1);
    media.socket.close();
    await h.waitFor(async () => (await h.calls.getBySid(CALL_SID))?.status === 'ended');
    expect((await h.calls.getBySid(CALL_SID))?.outcome).toBe('answered');
    expect(h.texts).toEqual([]);
    const calls = (await h.attemptsOf(delivery.id)).filter(attempt => attempt.channel === 'call');
    expect(calls.at(-1)?.detail).toMatch(/what was said is in the chat\.$/);
    expect(h.activity.at(-1)?.conversation_id).toBe('chat-1');
  });

  it('after a yes, does not read out a reminder that holds a number, and says why in a fixed line', async () => {
    h = await callsHarness({
      chat: { turns: new FakeTurns({ message: [] }), begin: () => Promise.resolve('chat-1') },
      listening: () => Promise.resolve({ vad: new LoudnessVad(), stt: new FakeStt('yes') }),
    });
    await h.readyToCall();
    await h.deliveries.deliver({
      ...ALICE,
      kind: 'reminder',
      level: 'call',
      text: 'Call five five five, twelve twelve',
      reason: 'You asked to be called.',
      link: null,
    });
    const media = await h.openMedia({ token: (await h.answer()).token });
    await sayYes(media);
    await h.waitFor(() => h.tts.sentences.join(' ').includes('is not something I read out on the phone'));
    expect(h.tts.sentences.join(' ')).not.toContain('five five five');
    expect(h.opened.map(open => open.opening).join(' ')).not.toContain('five five five');
    media.socket.close();
    await h.waitFor(async () => (await h.calls.getBySid(CALL_SID))?.status === 'ended');
  });

  it('writes no chat when the person hangs up while the message is still being spoken', async () => {
    let reached: () => void = () => undefined;
    const speaking = new Promise<void>(resolve => {
      reached = resolve;
    });
    const begun: string[] = [];
    const tts: FakeTts = new FakeTts({
      delay: text => {
        if (!text.includes('school pickup')) {
          return Promise.resolve();
        }
        reached();
        // Held until the line is closed, as a slow voice is when the person hangs up.
        return new Promise<void>(resolve => {
          tts.signals.get(text)?.addEventListener('abort', () => {
            resolve();
          });
        });
      },
    });
    h = await callsHarness({
      tts,
      chat: {
        turns: new FakeTurns({ message: [] }),
        begin: () => {
          begun.push('chat-1');
          return Promise.resolve('chat-1');
        },
      },
      listening: () => Promise.resolve({ vad: new LoudnessVad(), stt: new FakeStt('yes') }),
    });
    await h.readyToCall();
    const delivery = await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer()).token });
    await sayYes(media);
    await speaking;
    media.socket.close();
    await h.waitFor(async () => (await h.calls.getBySid(CALL_SID))?.status === 'ended');
    await pause(100);
    expect(begun).toEqual([]);
    expect((await h.calls.getBySid(CALL_SID))?.session_id).toBeNull();
    const calls = (await h.attemptsOf(delivery.id)).filter(attempt => attempt.channel === 'call');
    expect(calls.at(-1)?.detail).not.toContain('in the chat');
  });

  it('lets a call that was placed wait about 2 minutes for Twilio, not 5', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    const call = await h.calls.getBySid(CALL_SID);
    const waited = Date.parse(call?.expires_at ?? '') - Date.parse(call?.created_at ?? '');
    expect(waited).toBe(2 * 60_000);
  });

  it('when the voice cannot speak the message after a yes, writes no chat and sends a text and a push', async () => {
    const begun: string[] = [];
    h = await callsHarness({
      tts: new FakeTts({ failOn: text => text.includes('school pickup') }),
      chat: {
        turns: new FakeTurns({ message: [] }),
        begin: () => {
          begun.push('chat-1');
          return Promise.resolve('chat-1');
        },
      },
      listening: () => Promise.resolve({ vad: new LoudnessVad(), stt: new FakeStt('yes') }),
    });
    await h.readyToCall();
    const delivery = await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer()).token });
    await sayYes(media);
    expect(await media.closed).toBe(1000);
    await h.waitFor(() => h.texts.length === 1 && h.pushes.length === 1);
    expect(begun).toEqual([]);
    expect((await h.calls.getBySid(CALL_SID))?.outcome).toBe('failed');
    const calls = (await h.attemptsOf(delivery.id)).filter(attempt => attempt.channel === 'call');
    expect(calls.at(-1)?.detail).toBe(
      'You answered, but the message could not be read out. It was sent as a text and a notice instead.',
    );
  });

  it.each([
    ['a word the person added is read out', 'Collect Zorblax at noon.', 'zorblax', 'Zorblax'],
    ['an unknown word is not read out', 'Collect Quuxel at noon.', 'zorblax', undefined],
    ['the assistant name is read out', 'Mannie will remind you at noon.', undefined, 'Mannie'],
  ])('%s', async (_title, text, added, said) => {
    h = await callsHarness({
      chat: { turns: new FakeTurns({ message: [] }), begin: () => Promise.resolve('chat-1') },
      listening: () => Promise.resolve({ vad: new LoudnessVad(), stt: new FakeStt('yes') }),
    });
    if (added !== undefined) {
      await h.contacts.addWord({ ...ALICE, word: added, max: 50, now: new Date('2026-11-06T15:00:00.000Z') });
    }
    await h.readyToCall();
    await h.callDelivery(text);
    const media = await h.openMedia({ token: (await h.answer()).token });
    await sayYes(media);
    await h.waitFor(() => h.tts.sentences.join(' ').includes(said === undefined ? 'in the app' : said));
    expect(h.tts.sentences.join(' ').includes('Quuxel')).toBe(false);
    media.socket.close();
  });

  it('does not say what was said is in the chat when no chat was written', async () => {
    h = await callsHarness({
      chat: { turns: new FakeTurns({ message: [] }), begin: () => Promise.resolve(undefined) },
      listening: () => Promise.resolve({ vad: new LoudnessVad(), stt: new FakeStt('yes') }),
    });
    await h.readyToCall();
    const delivery = await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer()).token });
    await sayYes(media);
    await h.waitFor(() => h.tts.sentences.join(' ').includes('school pickup'));
    media.socket.close();
    await h.waitFor(async () => (await h.calls.getBySid(CALL_SID))?.status === 'ended');
    const calls = (await h.attemptsOf(delivery.id)).filter(attempt => attempt.channel === 'call');
    expect(calls.at(-1)?.detail).toBe('You answered. The call lasted about a minute.');
    expect(h.activity.at(-1)?.conversation_id).toBe('');
  });

  it.each([
    ['human', 'The call was answered, but the line could not be opened. It was sent as a text and a notice instead.'],
    [
      'machine_end_beep',
      'A voicemail picked up, but no message could be left. It was sent as a text and a notice instead.',
    ],
  ])(
    'when the voice service speaks without saying it checked the words (%s), says nothing and falls back',
    async (answeredBy, detail) => {
      const realFetch = globalThis.fetch;
      const asked: unknown[] = [];
      jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.startsWith(`${ttsBaseUrl()}/v1/speak`)) {
          return realFetch(input, init);
        }
        asked.push(JSON.parse(String(init?.body)));
        // An older voice service: it speaks anything and does not mark the words as checked.
        return Promise.resolve(new Response(new Uint8Array(160), { headers: { 'content-type': 'audio/basic' } }));
      });
      try {
        h = await callsHarness({ speaking: () => new SidecarSpeechSynthesizer() });
        await h.readyToCall();
        const delivery = await h.callDelivery();
        const media = await h.openMedia({ token: (await h.answer(answeredBy)).token });
        expect(await media.closed).toBe(1000);
        await h.waitFor(() => h.texts.length === 1 && h.pushes.length === 1);
        expect(asked).toEqual([expect.objectContaining({ exact: true, format: 'mulaw8k' })]);
        expect(media.frames.some(frame => frame.event === 'media')).toBe(false);
        const calls = (await h.attemptsOf(delivery.id)).filter(attempt => attempt.channel === 'call');
        expect(calls.at(-1)?.detail).toBe(detail);
      } finally {
        jest.restoreAllMocks();
      }
    },
  );

  it('when the line drops while its key is still being checked, still writes the call down and falls back', async () => {
    let reached: () => void = () => undefined;
    const atRedeem = new Promise<void>(resolve => {
      reached = resolve;
    });
    let open: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      open = resolve;
    });
    h = await callsHarness({ redeemGate: { reached, open: gate } });
    await h.readyToCall();
    await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer()).token });
    await atRedeem;
    media.socket.close();
    await media.closed;
    open();
    await h.waitFor(async () => (await h.calls.getBySid(CALL_SID))?.status === 'ended');
    await h.waitFor(() => h.pushes.length === 1);
    expect(h.tts.sentences).toEqual([]);
  });

  it('when the line drops while the call is starting, writes it down and says nothing on a closed line', async () => {
    let ready: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      ready = resolve;
    });
    h = await callsHarness({
      listening: async () => {
        await gate;
        return { vad: new LoudnessVad(), stt: new FakeStt() };
      },
    });
    await h.readyToCall();
    await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer()).token });
    await h.waitFor(async () => (await h.calls.getBySid(CALL_SID))?.status === 'connected');
    media.socket.close();
    await media.closed;
    await h.waitFor(async () => (await h.calls.getBySid(CALL_SID))?.status === 'ended');
    ready();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(h.tts.sentences).toEqual([]);
    expect(h.pushes).toHaveLength(1);
  });

  it('when Twilio says a call with an open line completed but no line is open here, writes it down once', async () => {
    h = await callsHarness();
    await h.readyToCall();
    const delivery = await h.callDelivery();
    const { token } = await h.answer();
    // The line was opened by a server that has since stopped: nothing in this one is holding it.
    await h.calls.redeemToken({
      call_sid: CALL_SID,
      token_hash: createHash('sha256')
        .update(token ?? '', 'utf8')
        .digest('hex'),
      now: h.clock.now,
    });
    await h.status('completed');
    await h.status('completed');
    await h.waitFor(async () => (await h.calls.getBySid(CALL_SID))?.status === 'ended');
    expect((await h.calls.getBySid(CALL_SID))?.outcome).toBe('answered');
    const calls = (await h.attemptsOf(delivery.id)).filter(attempt => attempt.channel === 'call');
    expect(calls.map(attempt => attempt.detail)).toEqual(['The phone is ringing.', 'You answered. The call ended.']);
    expect(h.texts).toEqual([]);
  });

  it('ends a call whose line was given but never closed, once its longest talk is over, as cut off', async () => {
    h = await callsHarness();
    await h.readyToCall();
    const delivery = await h.callDelivery();
    await h.answer();
    h.clock.now = new Date(h.clock.now.getTime() + 20 * 60_000);
    await h.service.sweep();
    expect((await h.calls.getBySid(CALL_SID))?.outcome).toBe('failed');
    const calls = (await h.attemptsOf(delivery.id)).filter(attempt => attempt.channel === 'call');
    expect(calls.at(-1)?.detail).toBe(
      'The call stopped before it finished. It was sent as a text and a notice instead.',
    );
    expect(h.texts).toHaveLength(1);
  });

  it('when Twilio could not be reached, says the text and the notice went out instead', async () => {
    h = await callsHarness();
    await h.readyToCall();
    h.nextCall.result = { outcome: 'failed', failure: 'unreachable' };
    const delivery = await h.callDelivery();
    const call = (await h.attemptsOf(delivery.id)).find(attempt => attempt.channel === 'call');
    expect(call?.detail).toBe('The call could not be started. It was sent as a text and a notice instead.');
    expect(h.texts).toHaveLength(1);
  });

  it('when no clear answer came back from Twilio, waits for the call instead of texting and then hanging up', async () => {
    h = await callsHarness();
    await h.readyToCall();
    h.nextCall.result = { outcome: 'unknown' };
    const delivery = await h.callDelivery();
    const call = (await h.attemptsOf(delivery.id)).find(attempt => attempt.channel === 'call');
    expect(call?.outcome).toBe('sent');
    expect(h.texts).toEqual([]);
    expect(h.pushes).toEqual([]);
    // Twilio did start it: its requests name the call by Aman's own id, so the line still opens.
    const { token } = await h.answer();
    expect(token).toBeDefined();
    const media = await h.openMedia({ token });
    await h.waitFor(() => h.tts.sentences.length > 0);
    media.socket.close();
    await h.waitFor(async () => (await h.calls.getBySid(CALL_SID))?.status === 'ended');
    expect(h.texts).toEqual([]);
  });

  it('when no clear answer came back and Twilio never calls, sends the text and the notice once the call expires', async () => {
    h = await callsHarness();
    await h.readyToCall();
    h.nextCall.result = { outcome: 'unknown' };
    const delivery = await h.callDelivery();
    expect(h.texts).toEqual([]);
    h.clock.now = new Date(h.clock.now.getTime() + 3 * 60_000);
    await h.service.sweep();
    expect(h.texts).toHaveLength(1);
    expect(h.pushes).toEqual([delivery.id]);
  });

  it('ends a call Twilio never called back about, once it expires, and sends a text and a push', async () => {
    h = await callsHarness();
    await h.readyToCall();
    const delivery = await h.callDelivery();
    await h.service.sweep();
    expect((await h.calls.getBySid(CALL_SID))?.status).toBe('ringing');
    h.clock.now = new Date(h.clock.now.getTime() + 6 * 60_000);
    await h.service.sweep();
    expect(h.pushes).toEqual([delivery.id]);
    expect(h.texts).toHaveLength(1);
    const calls = (await h.attemptsOf(delivery.id)).filter(attempt => attempt.channel === 'call');
    expect(calls.at(-1)?.detail).toBe('No one answered. It was sent as a text and a notice instead.');
    expect((await h.calls.getBySid(CALL_SID))?.outcome).toBe('no_answer');
    await h.service.sweep();
    expect(h.pushes).toHaveLength(1);
  });

  it('forgets ended calls after 30 days', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    await h.status('no-answer');
    await h.waitFor(() => h.pushes.length === 1);
    h.clock.now = new Date(h.clock.now.getTime() + 29 * 24 * 3_600_000);
    await h.service.sweep();
    expect(await h.calls.getBySid(CALL_SID)).toBeDefined();
    h.clock.now = new Date(h.clock.now.getTime() + 2 * 24 * 3_600_000);
    await h.service.sweep();
    expect(await h.calls.getBySid(CALL_SID)).toBeUndefined();
  });
});

describe('a conversation on the phone', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it('opens in private mode: who is calling, who for, only the kind of thing, then the question', async () => {
    h = await callsHarness();
    await h.readyToCall();
    const delivery = await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer()).token });
    await h.waitFor(() => h.tts.sentences.length >= 1);
    expect(h.tts.sentences.join(' ')).toBe(
      'Hi, this is Mannie, calling for Dana. Something needs you. Is this a good time?',
    );
    expect(h.tts.sentences.join(' ')).not.toContain('school pickup');
    media.socket.close();
    await h.waitFor(async () => (await h.calls.getBySid(CALL_SID))?.status === 'ended');
    expect((await h.calls.getBySid(CALL_SID))?.outcome).toBe('not_now');
    expect(h.opened).toEqual([]);
    const ended = (await h.attemptsOf(delivery.id)).filter(attempt => attempt.channel === 'call');
    expect(ended.at(-1)?.detail).toBe(
      'You answered, but the call ended before you said it was a good time. It is waiting for you in the app.',
    );
    // An answered call is not missed: no text, no push.
    expect(h.texts).toEqual([]);
    expect(h.pushes).toEqual([]);
  });

  it.each([
    ['Call 555 0100 now', 'Hi, this is your assistant, calling for Dana.'],
    ['Mannie the very helpful assistant', 'Hi, this is Mannie the very, calling for Dana.'],
  ])('says the assistant name "%s" by the same rule as a text', async (name, spoken) => {
    h = await callsHarness({ assistantName: name });
    await h.readyToCall();
    await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer()).token });
    await h.waitFor(() => h.tts.sentences.length > 0);
    expect(h.tts.sentences[0]).toContain(spoken);
    media.socket.close();
    await h.waitFor(async () => (await h.calls.getBySid(CALL_SID))?.status === 'ended');
  });

  it('speaks for the person it calls, so it waits its turn with their voice mode and read-aloud', async () => {
    const tts = new FakeTts();
    const owners: { tenant_id: string; created_by: string }[] = [];
    h = await callsHarness({
      tts,
      speaking: owner => {
        owners.push(owner);
        return tts;
      },
    });
    await h.readyToCall();
    await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer()).token });
    await h.waitFor(() => tts.sentences.length > 0);
    expect(owners).toEqual([ALICE]);
    media.socket.close();
    await h.waitFor(async () => (await h.calls.getBySid(CALL_SID))?.status === 'ended');
  });

  it('takes silence after the question as an answer it did not catch: asks once more, then says goodbye', async () => {
    h = await callsHarness({ limits: { silenceMs: 40 } });
    await h.readyToCall();
    await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer()).token });
    expect(await media.closed).toBe(1000);
    expect(h.tts.sentences.slice(1).join(' ')).toBe(`${CALL_LINES.askAgain} ${CALL_LINES.giveUp}`);
    expect(h.opened).toEqual([]);
  });

  it('treats an answered line where no one ever spoke as missed, as when a voicemail was not told apart, and falls back', async () => {
    h = await callsHarness({ limits: { silenceMs: 40 } });
    await h.readyToCall();
    const delivery = await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer('unknown')).token });
    expect(await media.closed).toBe(1000);
    await h.waitFor(() => h.texts.length === 1 && h.pushes.length === 1);
    expect((await h.calls.getBySid(CALL_SID))?.outcome).toBe('no_answer');
    const ended = (await h.attemptsOf(delivery.id)).filter(attempt => attempt.channel === 'call');
    expect(ended.at(-1)?.detail).toBe(
      'The call was answered, but no one spoke, so it may have been a voicemail. It was sent as a text and a notice instead.',
    );
  });

  it('starts the wait for an answer over when someone begins to speak, instead of talking over them', async () => {
    const stt = new FakeStt();
    stt.hold = true;
    // The wait for an answer is driven here, so what is proved does not depend on how fast the runner is.
    const waits: { cancelled: boolean }[] = [];
    h = await callsHarness({
      startSilence: () => {
        const wait = { cancelled: false };
        waits.push(wait);
        return () => {
          wait.cancelled = true;
        };
      },
      listening: () => Promise.resolve({ vad: new LoudnessVad(), stt }),
    });
    await h.readyToCall();
    await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer()).token });
    // The opening has played to the end, so the wait for an answer is running.
    await h.waitFor(() => waits.length === 1);
    expect(h.tts.sentences).toHaveLength(1);
    // Someone starts to talk. A second of sound counts as speech whether or not the opening is still playing out, and
    // it must start the wait over rather than let it run out.
    await sendSound(media, hum(1000));
    await h.waitFor(() => waits.length === 2);
    expect(waits.map(wait => wait.cancelled)).toEqual([true, false]);
    expect(h.tts.sentences).toHaveLength(1);
    media.socket.close();
    await h.waitFor(async () => (await h.calls.getBySid(CALL_SID))?.status === 'ended');
  });

  it('gives back the listening model once the call is over', async () => {
    let released = 0;
    class ReleasedVad extends LoudnessVad {
      dispose(): Promise<void> {
        released += 1;
        return Promise.resolve();
      }
    }
    h = await callsHarness({ listening: () => Promise.resolve({ vad: new ReleasedVad(), stt: new FakeStt() }) });
    await h.readyToCall();
    await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer()).token });
    await h.waitFor(() => h.tts.sentences.length >= 1);
    expect(released).toBe(0);
    media.socket.close();
    await h.waitFor(() => released === 1);
  });

  it('gives back the listening model when the line drops while it is still loading', async () => {
    let released = 0;
    class ReleasedVad extends LoudnessVad {
      dispose(): Promise<void> {
        released += 1;
        return Promise.resolve();
      }
    }
    let loaded: () => void = () => undefined;
    const loading = new Promise<void>(resolve => {
      loaded = resolve;
    });
    let asked = false;
    h = await callsHarness({
      listening: async () => {
        asked = true;
        await loading;
        return { vad: new ReleasedVad(), stt: new FakeStt() };
      },
    });
    await h.readyToCall();
    await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer()).token });
    await h.waitFor(() => asked);
    media.socket.close();
    await h.waitFor(async () => (await h.calls.getBySid(CALL_SID))?.status === 'ended');
    loaded();
    await h.waitFor(() => released === 1);
    expect(h.tts.sentences).toEqual([]);
  });

  it('says goodbye at the time limit without mentioning a chat, then hangs up', async () => {
    h = await callsHarness({ limits: { talkMs: 80, hangUpGraceMs: 400 } });
    await h.readyToCall();
    await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer()).token });
    await h.waitFor(() => h.tts.sentences.join(' ').endsWith(CALL_LINES.timeUp));
    expect(CALL_LINES.timeUp).toBe('I need to go now. Please open the app. Goodbye.');
    expect(CALL_LINES.timeUp).not.toMatch(/chat/i);
    await media.closed;
  });

  it('closes the line at the time limit even when the assistant is stuck mid-sentence', async () => {
    const stuck = new FakeTts({ delay: () => new Promise<void>(() => undefined) });
    h = await callsHarness({ tts: stuck, limits: { talkMs: 60, hangUpGraceMs: 40 } });
    await h.readyToCall();
    await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer()).token });
    await media.closed;
    await h.waitFor(async () => (await h.calls.getBySid(CALL_SID))?.status === 'ended');
    expect((await h.calls.getBySid(CALL_SID))?.outcome).toBe('not_now');
  });
});
