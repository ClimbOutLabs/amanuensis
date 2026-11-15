import { createHmac } from 'node:crypto';
import winston from 'winston';
import WebSocket from 'ws';

import { MEDIA_STREAM_PATH } from '../../../src/runtime/calls/twilioCalls';
import { INBOUND_SMS_PATH, inboundSmsRoute } from '../../../src/twilioWebhook/inboundSms';
import { startTwilioWebhookListener } from '../../../src/twilioWebhook/listener';
import { startApprovalTestServer } from '../../fixtures/approvalTestServer';
import { ACCOUNT_SID, AUTH_TOKEN, CALL_SID, PUBLIC_URL, callsHarness } from '../../fixtures/callsHarness';
import { closeServer, listeningPort } from '../../fixtures/listenPort';
import { ALICE, PHONE, textsHarness } from '../../fixtures/textsHarness';

/**
 * Twilio's signature as its documentation describes it, computed here and not by our own code: the public address,
 * then each form field as name and value sorted by name, signed with the auth token (HMAC-SHA1), in base64.
 */
function twilioSigns({ url, fields, token }: { url: string; fields: Record<string, string>; token: string }): string {
  const signed = Object.keys(fields)
    .sort()
    .reduce((text, name) => `${text}${name}${fields[name] ?? ''}`, url);
  return createHmac('sha1', token).update(signed).digest('base64');
}

const FORGED = 'f'.repeat(27) + '=';

/** The ways a request can fail to be Twilio's: no signature, a forged one, one made for another address, a changed body. */
function badSignatures({ url, fields }: { url: string; fields: Record<string, string> }) {
  const other = new URL(url);
  other.host = 'elsewhere.example.invalid';
  return [
    ['no signature', undefined, fields],
    ['a forged signature', FORGED, fields],
    ['a signature made with another token', twilioSigns({ url, fields, token: 'another-token' }), fields],
    ['a signature made for another host', twilioSigns({ url: other.toString(), fields, token: AUTH_TOKEN }), fields],
    [
      'a signature made for another path',
      twilioSigns({ url: `${PUBLIC_URL}/twilio/elsewhere`, fields, token: AUTH_TOKEN }),
      fields,
    ],
    [
      'a body changed after it was signed',
      twilioSigns({ url, fields, token: AUTH_TOKEN }),
      { ...fields, From: '+15550177' },
    ],
  ] as const;
}

async function postForm({
  base,
  path,
  fields,
  signature,
}: {
  base: string;
  path: string;
  fields: Record<string, string>;
  signature: string | undefined;
}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(signature === undefined ? {} : { 'x-twilio-signature': signature }),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

describe('our own signature check agrees with the signature Twilio documents', () => {
  it('signs the documented example the way Twilio does', () => {
    expect(
      twilioSigns({
        url: 'https://mycompany.com/myapp.php?foo=1&bar=2',
        token: '12345',
        fields: {
          CallSid: 'CA1234567890ABCDE',
          Caller: '+14158675310',
          Digits: '1234',
          From: '+14158675310',
          To: '+18005551212',
        },
      }),
    ).toBe('GvWf1cFY/Q7PnoempGyD5oXAezc=');
  });
});

describe('texts sent to the number, signed like Twilio signs them', () => {
  const settings = {
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    webhookPublicUrl: PUBLIC_URL,
    webhookPort: 0,
  };
  let h: Awaited<ReturnType<typeof textsHarness>>;
  let base: string;
  let close: () => Promise<void>;
  beforeEach(async () => {
    h = await textsHarness();
    await h.readyToText();
    const logger = winston.createLogger({ silent: true });
    const server = await startTwilioWebhookListener({
      settings,
      hostname: '127.0.0.1',
      routes: [inboundSmsRoute({ settings, textNumbers: h.numbers, logger })],
      logger,
    });
    base = `http://127.0.0.1:${String(await listeningPort(server))}`;
    close = () => closeServer(server);
  });
  afterEach(async () => {
    await close();
  });

  const url = `${PUBLIC_URL}${INBOUND_SMS_PATH}`;
  const signed = (fields: Record<string, string>) => twilioSigns({ url, fields, token: AUTH_TOKEN });
  const textsAreOn = async () => (await h.reachSettings.get(ALICE))?.channels.texts;

  it.each(['STOP', 'stop', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'])(
    'a signed %s switches texts off and is written to Activity',
    async word => {
      const fields = { AccountSid: ACCOUNT_SID, MessageSid: `SM${'1'.repeat(32)}`, From: PHONE, Body: word };
      const response = await postForm({ base, path: INBOUND_SMS_PATH, fields, signature: signed(fields) });
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      expect(await textsAreOn()).toBe(false);
      expect(h.activity.map(entry => entry.created_by)).toEqual(['alice']);
    },
  );

  it('ignores START and any other signed text: texts stay as they were and nothing is written back', async () => {
    for (const body of ['START', 'YES', 'hello there', 'please stop texting me']) {
      const fields = { AccountSid: ACCOUNT_SID, From: PHONE, Body: body };
      const response = await postForm({ base, path: INBOUND_SMS_PATH, fields, signature: signed(fields) });
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
    expect(await textsAreOn()).toBe(true);
    const stop = { AccountSid: ACCOUNT_SID, From: PHONE, Body: 'STOP' };
    await postForm({ base, path: INBOUND_SMS_PATH, fields: stop, signature: signed(stop) });
    const start = { AccountSid: ACCOUNT_SID, From: PHONE, Body: 'START' };
    await postForm({ base, path: INBOUND_SMS_PATH, fields: start, signature: signed(start) });
    expect(await textsAreOn()).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it.each(badSignatures({ url, fields: { AccountSid: ACCOUNT_SID, From: PHONE, Body: 'STOP' } }))(
    'refuses a STOP with %s, and changes nothing',
    async (_name, signature, fields) => {
      const response = await postForm({ base, path: INBOUND_SMS_PATH, fields, signature });
      expect(response.status).toBe(403);
      await expect(response.text()).resolves.toBe('');
      expect(await textsAreOn()).toBe(true);
      expect(h.activity).toEqual([]);
    },
  );
});

describe('calls answered and heard, signed like Twilio signs them', () => {
  let h: Awaited<ReturnType<typeof callsHarness>>;
  afterEach(async () => {
    await h.close();
  });

  const callId = () => h.placed.at(-1)?.call_id ?? '';
  const voiceFields = { AccountSid: ACCOUNT_SID, CallSid: CALL_SID, AnsweredBy: 'human', From: '+15550100', To: PHONE };
  const tokenIn = (twiml: string) => /<Parameter name="token" value="([^"]+)"/.exec(twiml)?.[1];

  async function voice({
    path,
    fields,
    signature,
  }: {
    path: string;
    fields: Record<string, string>;
    signature?: string | undefined;
  }) {
    return postForm({ base: h.base, path, fields, signature });
  }

  /** Opens the media stream with a signature made here, and says how the upgrade ended. */
  async function upgrade({ path, signature }: { path: string; signature: string | undefined }) {
    const socket = new WebSocket(`ws://127.0.0.1:${new URL(h.base).port}${path}`, {
      headers: signature === undefined ? {} : { 'x-twilio-signature': signature },
    });
    const how = await new Promise<number | 'open'>(resolve => {
      socket.on('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0);
      });
      socket.on('open', () => {
        resolve('open');
      });
      socket.on('error', () => {
        resolve(0);
      });
    });
    return { socket, how };
  }

  it('answers a signed voice webhook with a media address and a one-time key, and refuses the same request unsigned or forged', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    const path = `/twilio/voice?call=${callId()}`;
    const url = `${PUBLIC_URL}${path}`;
    for (const [, signature, fields] of badSignatures({ url, fields: voiceFields })) {
      const response = await voice({ path, fields, signature });
      expect(response.status).toBe(403);
      await expect(response.text()).resolves.toBe('');
    }
    expect((await h.calls.getBySid(CALL_SID))?.status).toBe('ringing');
    const good = await voice({
      path,
      fields: voiceFields,
      signature: twilioSigns({ url, fields: voiceFields, token: AUTH_TOKEN }),
    });
    expect(good.status).toBe(200);
    const twiml = await good.text();
    expect(twiml).toContain(`wss://aman.example.invalid${MEDIA_STREAM_PATH}/${callId()}`);
    expect(tokenIn(twiml)).toMatch(/^.{20,}$/);
  });

  it('hangs up, with no key, on a signed voice webhook for a call id Aman never placed', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    const path = `/twilio/voice?call=${'0'.repeat(26)}`;
    // Aman finds a call by Twilio's id when its own id does not match, so both are ones it never knew.
    const stranger = { ...voiceFields, CallSid: `CA${'c'.repeat(32)}` };
    const response = await voice({
      path,
      fields: stranger,
      signature: twilioSigns({ url: `${PUBLIC_URL}${path}`, fields: stranger, token: AUTH_TOKEN }),
    });
    const twiml = await response.text();
    expect(tokenIn(twiml)).toBeUndefined();
    expect(twiml).toContain('<Hangup');
    expect((await h.calls.getBySid(CALL_SID))?.status).toBe('ringing');
  });

  it('ends the call on a signed status webhook only, and ignores one that is unsigned, forged, for another address, or for an unknown call id', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    const fields = { AccountSid: ACCOUNT_SID, CallSid: CALL_SID, CallStatus: 'completed' };
    const path = `/twilio/call-status?call=${callId()}`;
    const url = `${PUBLIC_URL}${path}`;
    for (const [, signature, sent] of badSignatures({ url, fields })) {
      expect((await voice({ path, fields: sent, signature })).status).toBe(403);
    }
    const unknown = `/twilio/call-status?call=${'0'.repeat(26)}`;
    const stranger = { ...fields, CallSid: `CA${'c'.repeat(32)}` };
    await voice({
      path: unknown,
      fields: stranger,
      signature: twilioSigns({ url: `${PUBLIC_URL}${unknown}`, fields: stranger, token: AUTH_TOKEN }),
    });
    expect((await h.calls.getBySid(CALL_SID))?.status).toBe('ringing');
    const ok = await voice({ path, fields, signature: twilioSigns({ url, fields, token: AUTH_TOKEN }) });
    expect(ok.status).toBe(200);
    await h.waitFor(async () => (await h.calls.getBySid(CALL_SID))?.status === 'ended');
  });

  it('opens the media stream only for the signed address of the call that is waiting, and lets its key work once', async () => {
    h = await callsHarness();
    await h.readyToCall();
    await h.callDelivery();
    const { token } = await h.answer();
    expect(token).toBeDefined();
    const path = `${MEDIA_STREAM_PATH}/${callId()}`;
    const wss = `${PUBLIC_URL.replace(/^https:/, 'wss:')}${path}`;
    const signature = twilioSigns({ url: wss, fields: {}, token: AUTH_TOKEN });

    expect((await upgrade({ path, signature: undefined })).how).toBe(403);
    expect((await upgrade({ path, signature: FORGED })).how).toBe(403);
    expect(
      (await upgrade({ path, signature: twilioSigns({ url: wss, fields: {}, token: 'another-token' }) })).how,
    ).toBe(403);
    expect(
      (
        await upgrade({
          path,
          signature: twilioSigns({ url: `wss://elsewhere.example.invalid${path}`, fields: {}, token: AUTH_TOKEN }),
        })
      ).how,
    ).toBe(403);
    expect(
      (
        await upgrade({
          path,
          signature: twilioSigns({
            url: `${PUBLIC_URL.replace(/^https:/, 'wss:')}${MEDIA_STREAM_PATH}/${'0'.repeat(26)}`,
            fields: {},
            token: AUTH_TOKEN,
          }),
        })
      ).how,
    ).toBe(403);

    const first = await upgrade({ path, signature });
    expect(first.how).toBe('open');
    first.socket.send(
      JSON.stringify({
        event: 'start',
        start: { streamSid: 'MZ1', callSid: CALL_SID, customParameters: { token } },
      }),
    );
    await h.waitFor(() => h.tts.sentences.length > 0);
    // Replaying the same key, on a fresh and correctly signed upgrade, opens nothing: the call is no longer waiting.
    expect((await upgrade({ path, signature })).how).toBe(404);
    first.socket.close();
  });

  it('refuses a correctly signed stream for a call id Aman never placed, before the socket opens', async () => {
    h = await callsHarness();
    const path = `${MEDIA_STREAM_PATH}/${'0'.repeat(26)}`;
    const signature = twilioSigns({
      url: `${PUBLIC_URL.replace(/^https:/, 'wss:')}${path}`,
      fields: {},
      token: AUTH_TOKEN,
    });
    expect((await upgrade({ path, signature })).how).toBe(404);
  });
});

describe('the main app port', () => {
  it('never answers an address under /twilio/, signed or not', async () => {
    const app = await startApprovalTestServer();
    try {
      const fields = { AccountSid: ACCOUNT_SID, From: PHONE, Body: 'STOP' };
      for (const path of [
        INBOUND_SMS_PATH,
        '/twilio/voice',
        '/twilio/call-status',
        `${MEDIA_STREAM_PATH}/${'0'.repeat(26)}`,
      ]) {
        for (const signature of [undefined, twilioSigns({ url: `${PUBLIC_URL}${path}`, fields, token: AUTH_TOKEN })]) {
          const response = await app.request(path, {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              ...(signature === undefined ? {} : { 'x-twilio-signature': signature }),
            },
            body: new URLSearchParams(fields).toString(),
          });
          expect([path, response.status]).toEqual([path, 404]);
          expect(await response.text()).not.toContain('<Response');
        }
      }
    } finally {
      await app.close();
    }
  });
});
