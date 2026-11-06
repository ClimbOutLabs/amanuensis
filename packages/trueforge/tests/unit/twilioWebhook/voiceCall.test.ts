import WebSocket from 'ws';

import { MEDIA_STREAM_PATH } from '../../../src/runtime/calls/twilioCalls';
import { twilioSignature } from '../../../src/twilioWebhook/signature';
import { ACCOUNT_SID, AUTH_TOKEN, CALL_SID, PUBLIC_URL, callsHarness } from '../../fixtures/callsHarness';

type Harness = Awaited<ReturnType<typeof callsHarness>>;

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

  it('takes a media socket signed over the https form of its address too', async () => {
    h = await callsHarness();
    const port = new URL(h.base).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}${MEDIA_STREAM_PATH}`, {
      headers: {
        'x-twilio-signature': twilioSignature({
          authToken: AUTH_TOKEN,
          url: `${PUBLIC_URL}${MEDIA_STREAM_PATH}`,
          params: new URLSearchParams(),
        }),
      },
    });
    const opened = await new Promise<boolean>(resolve => {
      socket.on('open', () => {
        resolve(true);
      });
      socket.on('unexpected-response', () => {
        resolve(false);
      });
    });
    expect(opened).toBe(true);
    socket.close();
  });

  it('serves nothing but its own routes, and takes no WebSocket at any other address', async () => {
    h = await callsHarness();
    for (const path of ['/twilio/voice', '/twilio/call-status', '/twilio/media', '/api/v1/voice/stream', '/']) {
      expect([path, (await fetch(`${h.base}${path}`)).status]).toEqual([path, 404]);
    }
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

  it('gives a request carrying the old in-process header no way into the app', async () => {
    h = await callsHarness();
    // The header an earlier design used for in-process callers; nothing reads it now.
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

  it('does nothing twice for a repeated status webhook: no second text or push', async () => {
    h = await callsHarness();
    await h.readyToCall();
    const delivery = await h.callDelivery();
    for (let n = 0; n < 3; n += 1) {
      expect((await h.status('no-answer')).status).toBe(200);
    }
    await h.waitFor(() => h.pushes.length > 0);
    expect(h.pushes).toEqual([delivery.id]);
    expect(h.texts).toHaveLength(1);
  });

  it('answers a retried voice webhook with a new media key while the line waits, so a slow retry never hangs up', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    const first = await h.answer();
    const retry = await h.answer();
    expect(retry.twiml).toContain('<Connect>');
    expect(retry.token).toBeDefined();
    expect(retry.token).not.toBe(first.token);
    expect(await (await h.openMedia({ token: first.token })).closed).toBe(1008);
    const opened = await h.openMedia({ token: retry.token });
    await h.waitFor(() => h.tts.sentences.length > 0);
    // Once the line is open, no key is given again.
    expect((await h.answer()).twiml).toContain('<Hangup/>');
    opened.socket.close();
    await opened.closed;
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

  it('hangs up on, or ignores, a webhook whose fields are not what Twilio sends', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    const badSid = await h.twilioPost({
      path: '/twilio/voice',
      fields: { AccountSid: ACCOUNT_SID, CallSid: 'CA-not-a-call', AnsweredBy: 'human' },
    });
    expect(await badSid.text()).toContain('<Hangup/>');
    const badAnswer = await h.twilioPost({
      path: '/twilio/voice',
      fields: { AccountSid: ACCOUNT_SID, CallSid: CALL_SID, AnsweredBy: 'robot' },
    });
    expect(await badAnswer.text()).toContain('<Hangup/>');
    expect((await h.status('exploded')).status).toBe(200);
    expect((await h.calls.getBySid(CALL_SID))?.status).toBe('ringing');
    expect(h.pushes).toEqual([]);
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

  it('lets a media token open the line once', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    const { token } = await h.answer();
    const opened = await h.openMedia({ token });
    await h.waitFor(() => h.tts.sentences.length > 0);
    const again = await h.openMedia({ token });
    expect(await again.closed).toBe(1008);
    opened.socket.close();
    await opened.closed;
  });
});
