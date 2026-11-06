import { createHash } from 'node:crypto';

import { CALL_LINES } from '../../../../src/runtime/calls/callTurns';
import { CALLS_NEED_VOICE } from '../../../../src/runtime/calls/phoneCalls';
import { readReachHistory } from '../../../../src/runtime/noticing/reachGate';
import { ACCOUNT_SID, ALICE, CALL_SID, PHONE, callsHarness } from '../../../fixtures/callsHarness';
import { FakeStt, FakeTts, LoudnessVad } from '../../../fixtures/voice/fakes';

type Harness = Awaited<ReturnType<typeof callsHarness>>;

const OTHER_SID = `CA${'c'.repeat(32)}`;

/** A call row whose Twilio id was never saved, as when saving it failed or Twilio answered slowly. */
async function callWithoutSid(h: Harness) {
  const delivery = await h.deliveries.deliver({
    ...ALICE,
    kind: 'nudge',
    level: 'call',
    text: 'Your 3pm clashes.',
    reason: 'Two things at once.',
    link: null,
    only_channels: [],
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
  });

  it('does not ring while the voice parts are not running, says so, and sends a text and a push instead', async () => {
    h = await callsHarness({ voiceReady: false });
    await h.readyToCall();
    const delivery = await h.callDelivery();
    expect(h.placed).toEqual([]);
    const call = (await h.attemptsOf(delivery.id)).find(attempt => attempt.channel === 'call');
    expect(call).toMatchObject({ outcome: 'skipped', detail: CALLS_NEED_VOICE });
    expect(h.texts).toHaveLength(1);
    expect(h.pushes).toEqual([delivery.id]);
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
      'No one answered. The call was not tried again.',
    );
    expect((await h.calls.getBySid(CALL_SID))?.outcome).toBe('no_answer');
  });

  it('on a voicemail, leaves one short message in the assistant’s own voice, then one text and one push', async () => {
    h = await callsHarness();
    await h.readyToCall();
    const delivery = await h.callDelivery('Your bill of $482.10 from Northwind Power is due Friday.');
    const { twiml, token } = await h.answer('machine_end_beep');
    expect(twiml).toContain('<Connect><Stream url="wss://aman.example.invalid/twilio/media">');
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
      'A voicemail picked up, but no message could be left. The call was not tried again.',
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
      only_channels: [],
    });
    expect((await h.service.place({ owner: ALICE, delivery, fallback: false })).outcome).toBe('sent');
    await h.status('busy');
    expect(h.texts).toEqual([]);
    expect(h.pushes).toEqual([]);
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
      'The call was answered, but the line could not be opened. The call was not tried again.',
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
    expect(calls.map(attempt => attempt.detail)).toEqual([
      'The phone is ringing.',
      'You answered. The call ended. Anything that was said is in the chat.',
    ]);
    expect(h.texts).toEqual([]);
  });

  it('ends a call Twilio never called back about, once it expires, and sends a text and a push', async () => {
    h = await callsHarness();
    await h.readyToCall();
    const delivery = await h.callDelivery();
    await h.service.sweep();
    expect((await h.calls.getBySid(CALL_SID))?.status).toBe('ringing');
    h.clock.now = new Date(h.clock.now.getTime() + 6 * 60_000);
    await h.service.sweep();
    expect((await h.calls.getBySid(CALL_SID))?.outcome).toBe('failed');
    expect(h.pushes).toEqual([delivery.id]);
    expect(h.texts).toHaveLength(1);
    const calls = (await h.attemptsOf(delivery.id)).filter(attempt => attempt.channel === 'call');
    expect(calls.at(-1)?.detail).toBe('The call stopped before it finished. The call was not tried again.');
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
    await h.waitFor(() => h.tts.sentences.length >= 3);
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
    ['Mannie the very helpful assistant', 'Hi, this is Mannie the very help, calling for Dana.'],
  ])('says the assistant name "%s" by the same rule as a text', async (name, spoken) => {
    h = await callsHarness({ assistantName: name });
    await h.readyToCall();
    await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer()).token });
    await h.waitFor(() => h.tts.sentences.length > 0);
    expect(h.tts.sentences[0]).toBe(spoken);
    media.socket.close();
    await h.waitFor(async () => (await h.calls.getBySid(CALL_SID))?.status === 'ended');
  });

  it('takes silence after the question as an answer it did not catch: asks once more, then says goodbye', async () => {
    h = await callsHarness({ limits: { silenceMs: 40 } });
    await h.readyToCall();
    const delivery = await h.callDelivery();
    const media = await h.openMedia({ token: (await h.answer()).token });
    expect(await media.closed).toBe(1000);
    expect(h.tts.sentences.slice(3).join(' ')).toBe(`${CALL_LINES.askAgain} ${CALL_LINES.giveUp}`);
    await h.waitFor(async () => (await h.calls.getBySid(CALL_SID))?.outcome === 'not_now');
    expect(h.opened).toEqual([]);
    const ended = (await h.attemptsOf(delivery.id)).filter(attempt => attempt.channel === 'call');
    expect(ended.at(-1)?.detail).toContain('the call ended before you said it was a good time');
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
    await h.waitFor(() => h.tts.sentences.length >= 3);
    expect(released).toBe(0);
    media.socket.close();
    await h.waitFor(() => released === 1);
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
