import { applyReachRules } from '../../../../src/runtime/noticing/reachRules';
import { defaultReachSettings } from '../../../../src/schemas/reach';
import { ACCOUNT_SID, ALICE, CALL_SID, PHONE, callsHarness } from '../../../fixtures/callsHarness';

type Harness = Awaited<ReturnType<typeof callsHarness>>;

const waitFor = async (check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> => {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) {
      throw new Error('timed out');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

async function attemptsOf(h: Harness, id: string) {
  return (await h.deliveryStore.get({ ...ALICE, id }))?.attempts ?? [];
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
    const call = delivery.attempts.find(attempt => attempt.channel === 'call');
    expect(call?.outcome).toBe('skipped');
    // The quiet defaults never let a call through the rules either.
    const decision = applyReachRules({
      subject: { kind: 'calendar_clash', evidence: 'own' },
      asked: 'call',
      settings: defaultReachSettings('UTC'),
      history: { nudges_today: 0, last_call_at: undefined },
      now: h.clock.now,
      calls_available: true,
    });
    expect(decision.delivered).not.toBe('call');
  });

  it('rings the confirmed number once, records it as a call attempt, and sends no push or text while it rings', async () => {
    h = await callsHarness();
    await h.readyToCall();
    const delivery = await h.callDelivery();
    expect(h.placed).toEqual([PHONE]);
    expect(delivery.attempts.map(attempt => [attempt.channel, attempt.outcome])).toEqual([
      ['in_app', 'sent'],
      ['call', 'sent'],
    ]);
    expect(delivery.attempts[1]?.target).toBe('number ending 0111');
    expect(h.pushes).toEqual([]);
    expect(h.texts).toEqual([]);
    expect(h.activity.map(row => row.tool_name)).toContain('delivery.call');
  });

  it('does not call a number that is not confirmed, and falls back to a push at once', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.contacts.remove(ALICE);
    const delivery = await h.callDelivery();
    expect(h.placed).toEqual([]);
    expect((await attemptsOf(h, delivery.id)).find(attempt => attempt.channel === 'call')?.outcome).toBe('skipped');
    expect(h.pushes).toEqual([delivery.id]);
  });

  it('when no one answers, leaves one text and one push, and never calls again', async () => {
    h = await callsHarness();
    await h.readyToCall();
    const delivery = await h.callDelivery();
    const status = { AccountSid: ACCOUNT_SID, CallSid: CALL_SID, CallStatus: 'no-answer' };
    expect((await h.twilioPost({ path: '/twilio/call-status', fields: status })).status).toBe(200);
    // Twilio may tell us twice; nothing happens twice.
    await h.twilioPost({ path: '/twilio/call-status', fields: status });
    await h.twilioPost({ path: '/twilio/call-status', fields: { ...status, CallStatus: 'completed' } });
    expect(h.placed).toEqual([PHONE]);
    expect(h.texts).toHaveLength(1);
    expect(h.texts[0]?.body).toBe('Mannie: something needs you. Open the app to see it.');
    expect(h.pushes).toEqual([delivery.id]);
    const attempts = await attemptsOf(h, delivery.id);
    expect(attempts.filter(attempt => attempt.channel === 'call').map(attempt => attempt.outcome)).toEqual([
      'sent',
      'failed',
    ]);
    expect(attempts.find(attempt => attempt.outcome === 'failed')?.detail).toContain('not tried again');
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
    await waitFor(async () => (await h.calls.getBySid(CALL_SID))?.outcome === 'voicemail');
    expect(h.tts.sentences).toEqual(['Mannie here, something needs you, please open the app.']);
    expect(media.frames.some(frame => frame.event === 'media')).toBe(true);
    await h.twilioPost({
      path: '/twilio/call-status',
      fields: { AccountSid: ACCOUNT_SID, CallSid: CALL_SID, CallStatus: 'completed' },
    });
    await waitFor(() => h.texts.length === 1 && h.pushes.length === 1);
    expect(h.texts[0]?.body).not.toContain('482');
    expect(h.pushes).toEqual([delivery.id]);
    expect(h.placed).toHaveLength(1);
    const calls = (await attemptsOf(h, delivery.id)).filter(attempt => attempt.channel === 'call');
    expect(calls.map(attempt => attempt.outcome)).toEqual(['sent', 'sent']);
    expect(calls[1]?.detail).toContain('voicemail');
  });

  it('a test call never falls back to a text', async () => {
    h = await callsHarness();
    await h.readyToCall();
    const delivery = await h.deliveries.deliver({
      ...ALICE,
      kind: 'nudge',
      level: 'call',
      text: 'This is a test call.',
      reason: 'You pressed Try it.',
      link: null,
      only_channels: [],
    });
    expect((await h.service.place({ owner: ALICE, delivery, fallback: false })).outcome).toBe('sent');
    await h.twilioPost({
      path: '/twilio/call-status',
      fields: { AccountSid: ACCOUNT_SID, CallSid: CALL_SID, CallStatus: 'busy' },
    });
    expect(h.texts).toEqual([]);
    expect(h.pushes).toEqual([]);
  });
});

describe('the Twilio listener for calls', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it('rejects an unsigned voice or status webhook, and runs nothing', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    const fields = { AccountSid: ACCOUNT_SID, CallSid: CALL_SID, AnsweredBy: 'human' };
    expect((await h.twilioPost({ path: '/twilio/voice', fields, sign: false })).status).toBe(403);
    expect(
      (await h.twilioPost({ path: '/twilio/call-status', fields: { ...fields, CallStatus: 'no-answer' }, sign: false }))
        .status,
    ).toBe(403);
    expect((await h.calls.getBySid(CALL_SID))?.status).toBe('ringing');
    expect(h.texts).toEqual([]);
  });

  it('refuses an unsigned media socket before it opens', async () => {
    h = await callsHarness();
    const media = await h.openMedia({ token: 'anything', sign: false });
    expect(media.refusedWith).toBe(403);
  });

  it('serves nothing but its own routes, and takes no WebSocket at any other address', async () => {
    h = await callsHarness();
    for (const path of ['/twilio/voice', '/twilio/call-status', '/twilio/media', '/api/v1/voice/stream', '/']) {
      expect([path, (await fetch(`${h.base}${path}`)).status]).toEqual([path, 404]);
    }
    const { default: WebSocket } = await import('ws');
    const stray = new WebSocket(`${h.base.replace('http:', 'ws:')}/api/v1/voice/stream`);
    const status = await new Promise<number | undefined>(resolve => {
      stray.on('unexpected-response', (_request, response) => {
        resolve(response.statusCode);
      });
      stray.on('open', () => {
        resolve(undefined);
      });
    });
    expect(status).toBe(404);
  });

  it('gives a request no way in by claiming to come from inside Aman', async () => {
    h = await callsHarness();
    const headers = { 'x-aman-in-process-caller': 'a'.repeat(43), 'sec-fetch-site': 'same-origin' };
    for (const path of ['/api/v1/sessions/chat-1/turns', '/api/v1/user/reach', '/']) {
      expect([path, (await fetch(`${h.base}${path}`, { method: 'POST', headers })).status]).toEqual([path, 404]);
    }
    const unsigned = await fetch(`${h.base}/twilio/voice`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'CallSid=x',
    });
    expect(unsigned.status).toBe(403);
  });

  it('hangs up on a call Aman did not start, and on one from another account', async () => {
    h = await callsHarness();
    const unknown = await h.twilioPost({
      path: '/twilio/voice',
      fields: { AccountSid: ACCOUNT_SID, CallSid: `CA${'c'.repeat(32)}`, AnsweredBy: 'human' },
    });
    expect(await unknown.text()).toContain('<Hangup/>');
    await h.readyToCall();
    await h.callDelivery();
    const other = await h.twilioPost({
      path: '/twilio/voice',
      fields: { AccountSid: `AC${'d'.repeat(32)}`, CallSid: CALL_SID, AnsweredBy: 'human' },
    });
    expect(await other.text()).toContain('<Hangup/>');
  });

  it('opens no media session for an unknown token, a token for another call, a used token or an expired one', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    const { token } = await h.answer();
    expect(token).toBeDefined();

    expect(await (await h.openMedia({ token: 'not-a-token' })).closed).toBe(1008);
    expect(await (await h.openMedia({ token: undefined })).closed).toBe(1008);
    expect(await (await h.openMedia({ token, callSid: `CA${'e'.repeat(32)}` })).closed).toBe(1008);

    h.clock.now = new Date(h.clock.now.getTime() + 60_000);
    expect(await (await h.openMedia({ token })).closed).toBe(1008);
    expect(h.tts.sentences).toEqual([]);
  });

  it('gives out a media token once per call, and a token works once', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    const first = await h.answer();
    const second = await h.answer();
    expect(first.token).toBeDefined();
    expect(second.twiml).toContain('<Hangup/>');

    const opened = await h.openMedia({ token: first.token });
    await waitFor(() => h.tts.sentences.length > 0);
    const again = await h.openMedia({ token: first.token });
    expect(await again.closed).toBe(1008);
    opened.socket.close();
    await opened.closed;
  });

  it('opens a call in private mode: the assistant gives its own name and only the kind of thing, and asks first', async () => {
    h = await callsHarness();
    await h.readyToCall();
    const delivery = await h.callDelivery();
    const { token } = await h.answer();
    const media = await h.openMedia({ token });
    await waitFor(() => h.tts.sentences.length > 0);
    expect(h.tts.sentences[0]).toBe("Hi, it's Mannie.");
    expect(h.tts.sentences.join(' ')).toBe("Hi, it's Mannie. Something needs you. Is this a good time?");
    expect(h.tts.sentences.join(' ')).not.toContain('Dana');
    media.socket.close();
    await waitFor(async () => (await h.calls.getBySid(CALL_SID))?.status === 'ended');
    expect((await h.calls.getBySid(CALL_SID))?.outcome).toBe('not_now');
    expect(h.opened).toEqual([]);
    const ended = (await attemptsOf(h, delivery.id)).filter(attempt => attempt.channel === 'call');
    expect(ended.at(-1)?.detail).toContain('not a good time');
    // An answered call is not missed: no text, no push.
    expect(h.texts).toEqual([]);
    expect(h.pushes).toEqual([]);
  });
});

describe('the rules before a call is placed', () => {
  const ticked = {
    ...defaultReachSettings('UTC'),
    channels: { texts: true, calls: true },
    call_kinds: ['calendar_clash' as const],
  };
  const ask = ({ now, last_call_at }: { now: Date; last_call_at?: Date }) =>
    applyReachRules({
      subject: { kind: 'calendar_clash', evidence: 'own' },
      asked: 'call',
      settings: ticked,
      history: { nudges_today: 0, last_call_at },
      now,
      calls_available: true,
    });

  it('calls when the kind is ticked, calls are on and nothing holds it back', () => {
    expect(ask({ now: new Date('2026-11-06T15:00:00.000Z') }).delivered).toBe('call');
  });

  it('holds a call back in quiet hours, and says so', () => {
    const decision = ask({ now: new Date('2026-11-06T22:30:00.000Z') });
    expect(decision.delivered).toBe('nudge');
    expect(decision.steps).toContain('It is during your quiet hours, so no call.');
  });

  it('allows one call in 6 hours', () => {
    const now = new Date('2026-11-06T15:00:00.000Z');
    expect(ask({ now, last_call_at: new Date(now.getTime() - 2 * 3_600_000) }).delivered).toBe('nudge');
    expect(ask({ now, last_call_at: new Date(now.getTime() - 7 * 3_600_000) }).delivered).toBe('call');
  });
});
