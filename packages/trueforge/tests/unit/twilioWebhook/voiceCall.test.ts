import { connect } from 'node:net';
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
    await h.readyToCall();
    await h.callDelivery();
    await h.answer();
    const port = new URL(h.base).port;
    const path = `${MEDIA_STREAM_PATH}/${h.placed.at(-1)?.call_id ?? ''}`;
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: {
        'x-twilio-signature': twilioSignature({
          authToken: AUTH_TOKEN,
          url: `${PUBLIC_URL}${path}`,
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

  it('refuses a stream for a call it does not know, or that already ended, before the socket opens', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    await h.answer();
    expect((await h.openMedia({ token: 'x', callId: 'no-such-call', start: false })).refusedWith).toBe(404);
    await h.status('completed');
    await h.waitFor(async () => (await h.calls.getBySid(CALL_SID))?.status === 'ended');
    expect((await h.openMedia({ token: 'x', start: false })).refusedWith).toBe(404);
  });

  it.each(['%E0%A4%A', '%', 'a'.repeat(200), '..%2F..%2Fetc', `${'a'.repeat(25)}%2F`])(
    'answers a stream address of "%s" with 404 before any signature, and keeps serving',
    async id => {
      h = await callsHarness();
      await h.readyToCall();
      await h.callDelivery();
      const port = new URL(h.base).port;
      const socket = new WebSocket(`ws://127.0.0.1:${port}${MEDIA_STREAM_PATH}/${id}`);
      const refused = await new Promise<number | undefined>(resolve => {
        socket.on('unexpected-response', (_request, response) => {
          resolve(response.statusCode);
        });
        socket.on('open', () => {
          resolve(undefined);
        });
        socket.on('error', () => undefined);
      });
      expect(refused).toBe(404);
      // The listener is still up and still answers Twilio.
      expect((await h.answer()).token).toBeDefined();
    },
  );

  it('keeps serving when a signed stream is reset while its call is looked up', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    await h.answer();
    const callId = h.placed.at(-1)?.call_id ?? '';
    // The lookup takes a moment, long enough for the other end to go away first.
    const lookup = h.calls.get.bind(h.calls);
    jest.spyOn(h.calls, 'get').mockImplementation(async id => {
      await new Promise(resolve => setTimeout(resolve, 150));
      return lookup(id);
    });
    const path = `${MEDIA_STREAM_PATH}/${callId}`;
    const signature = twilioSignature({
      authToken: AUTH_TOKEN,
      url: `${PUBLIC_URL.replace(/^https:/, 'wss:')}${path}`,
      params: new URLSearchParams(),
    });
    const socket = connect({ host: '127.0.0.1', port: Number(new URL(h.base).port) });
    await new Promise<void>(resolve => {
      socket.on('connect', resolve);
    });
    socket.on('error', () => undefined);
    socket.write(
      [
        `GET ${path} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        `X-Twilio-Signature: ${signature}`,
        '',
        '',
      ].join('\r\n'),
    );
    await new Promise(resolve => setTimeout(resolve, 30));
    socket.resetAndDestroy();
    await new Promise(resolve => setTimeout(resolve, 300));
    const reply = await h.twilioPost({
      path: `/twilio/voice?call=${callId}`,
      fields: { AccountSid: ACCOUNT_SID, CallSid: CALL_SID, AnsweredBy: 'human' },
    });
    expect(reply.status).toBe(200);
  });

  const maskless = Buffer.alloc(4);
  const malformedFrames: [string, Buffer][] = [
    ['a frame without a mask', Buffer.from([0x81, 0x02, 0x68, 0x69])],
    ['a frame over the size limit', Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0, 1, 0x11, 0x70, ...maskless])],
    ['a frame with a reserved opcode', Buffer.from([0x83, 0x80, ...maskless])],
    ['a text frame that is not valid text', Buffer.from([0x81, 0x82, ...maskless, 0xff, 0xfe])],
    ['a close frame with an invalid code', Buffer.from([0x88, 0x82, ...maskless, 0x03, 0xe7])],
  ];

  it.each(malformedFrames)(
    'ends only that call when an open stream sends %s, and serves the next request',
    async (_name, frame) => {
      h = await callsHarness();
      await h.readyToCall();
      await h.callDelivery();
      await h.answer();
      const callId = h.placed.at(-1)?.call_id ?? '';
      const path = `${MEDIA_STREAM_PATH}/${callId}`;
      const signature = twilioSignature({
        authToken: AUTH_TOKEN,
        url: `${PUBLIC_URL.replace(/^https:/, 'wss:')}${path}`,
        params: new URLSearchParams(),
      });
      const socket = connect({ host: '127.0.0.1', port: Number(new URL(h.base).port) });
      const closed = new Promise<void>(resolve => {
        socket.on('close', () => {
          resolve();
        });
      });
      socket.on('error', () => undefined);
      let seen = '';
      const opened = new Promise<void>(resolve => {
        socket.on('data', chunk => {
          seen += chunk.toString('latin1');
          if (seen.includes('\r\n\r\n')) {
            resolve();
          }
        });
      });
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          'Host: 127.0.0.1',
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          `X-Twilio-Signature: ${signature}`,
          '',
          '',
        ].join('\r\n'),
      );
      await opened;
      expect(seen).toContain('101');
      socket.write(frame);
      await closed;
      const reply = await h.twilioPost({
        path: `/twilio/voice?call=${callId}`,
        fields: { AccountSid: ACCOUNT_SID, CallSid: CALL_SID, AnsweredBy: 'human' },
      });
      expect(reply.status).toBe(200);
    },
  );

  it('gives each call its own signed address, so one call’s signature opens no other call', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    await h.answer();
    const port = new URL(h.base).port;
    const callId = h.placed.at(-1)?.call_id ?? '';
    const socket = new WebSocket(`ws://127.0.0.1:${port}${MEDIA_STREAM_PATH}/${callId}`, {
      headers: {
        'x-twilio-signature': twilioSignature({
          authToken: AUTH_TOKEN,
          url: `${PUBLIC_URL.replace(/^https:/, 'wss:')}${MEDIA_STREAM_PATH}/another-call`,
          params: new URLSearchParams(),
        }),
      },
    });
    const refused = await new Promise<number | undefined>(resolve => {
      socket.on('unexpected-response', (_request, response) => {
        resolve(response.statusCode);
      });
      socket.on('open', () => {
        resolve(undefined);
      });
    });
    expect(refused).toBe(403);
  });

  it('refuses a stream whose start names a different call than its address', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    const { token } = await h.answer();
    // The address names a call that is live, but the start carries another call's key.
    const other = await h.openMedia({ token, callSid: `CA${'e'.repeat(32)}` });
    expect(await other.closed).toBe(1008);
    expect(h.tts.sentences).toEqual([]);
  });

  it('still connects a real call while signed upgrades for an ended call arrive in a burst', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    const { token } = await h.answer();
    const ended = h.placed.at(-1)?.call_id ?? '';
    const flood = await Promise.all(
      Array.from({ length: 40 }, () => h.openMedia({ token: undefined, callId: `${ended}-old`, start: false })),
    );
    expect(flood.every(socket => socket.refusedWith === 404)).toBe(true);
    const line = await h.openMedia({ token });
    await h.waitFor(() => h.tts.sentences.length > 0);
    line.socket.close();
    await line.closed;
  });

  it('serves nothing but its own routes, and takes no WebSocket at any other address', async () => {
    h = await callsHarness();
    for (const path of [
      '/twilio/voice',
      '/twilio/call-status',
      '/twilio/media',
      '/twilio/media/x/y',
      '/api/v1/voice/stream',
      '/',
    ]) {
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

  it('makes room for a line by closing the one that has waited longest to name its call, when 8 wait', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    const { token } = await h.answer();
    const waiting = [];
    for (let n = 0; n < 8; n += 1) {
      waiting.push(await h.openMedia({ token: undefined, start: false }));
    }
    const line = await h.openMedia({ token });
    expect(await waiting[0]?.closed).toBe(1013);
    await h.waitFor(() => h.tts.sentences.length > 0);
    for (const socket of [...waiting.slice(1), line]) {
      socket.socket.close();
      await socket.closed;
    }
  });

  it('closes a line that has not named its call within a few seconds', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    await h.answer();
    const started = Date.now();
    const idle = await h.openMedia({ token: undefined, start: false });
    expect(await idle.closed).toBe(1008);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('lets a media token open the line once', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    const { token } = await h.answer();
    const opened = await h.openMedia({ token });
    await h.waitFor(() => h.tts.sentences.length > 0);
    // The call is no longer waiting for a stream, so a second one is refused before it opens.
    const again = await h.openMedia({ token });
    expect(again.refusedWith).toBe(404);
    opened.socket.close();
    await opened.closed;
  });
});
