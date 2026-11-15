import winston from 'winston';

import { INBOUND_SMS_PATH, inboundSmsRoute } from '../../../src/twilioWebhook/inboundSms';
import { startTwilioWebhookListener } from '../../../src/twilioWebhook/listener';
import { twilioSignature } from '../../../src/twilioWebhook/signature';
import { closeServer, listeningPort } from '../../fixtures/listenPort';
import { ALICE, PHONE, textsHarness } from '../../fixtures/textsHarness';

const settings = {
  accountSid: `AC${'2'.repeat(32)}`,
  authToken: 'token-for-tests',
  webhookPublicUrl: 'https://aman.example.invalid',
  webhookPort: 0,
};

async function serve() {
  const h = await textsHarness();
  await h.readyToText();
  const logger = winston.createLogger({ silent: true });
  const server = await startTwilioWebhookListener({
    settings,
    hostname: '127.0.0.1',
    routes: [inboundSmsRoute({ settings, textNumbers: h.numbers, logger })],
    logger,
  });
  const port = await listeningPort(server);
  const post = async ({ fields, sign = true }: { fields: Record<string, string>; sign?: boolean }) => {
    const params = new URLSearchParams(fields);
    return fetch(`http://127.0.0.1:${String(port)}${INBOUND_SMS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(sign
          ? {
              'x-twilio-signature': twilioSignature({
                authToken: settings.authToken,
                url: `${settings.webhookPublicUrl}${INBOUND_SMS_PATH}`,
                params,
              }),
            }
          : {}),
      },
      body: params.toString(),
    });
  };
  return {
    h,
    post,
    close: () => closeServer(server),
  };
}

describe('inbound texts', () => {
  let s: Awaited<ReturnType<typeof serve>>;
  beforeEach(async () => {
    s = await serve();
  });
  afterEach(async () => {
    await s.close();
  });

  it.each(['STOP', 'stop', 'Unsubscribe', 'QUIT', 'CANCEL', 'END', 'STOPALL'])(
    'a signed %s turns texts off for that number and is recorded in Activity',
    async word => {
      const response = await s.post({ fields: { From: PHONE, Body: word, AccountSid: settings.accountSid } });
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      expect((await s.h.reachSettings.get(ALICE))?.channels.texts).toBe(false);
      expect(s.h.activity.map(row => row.tool_name)).toContain('delivery.sms_stop');
    },
  );

  it('acts on one message once, however often the same signed request arrives', async () => {
    const stop = jest.spyOn(s.h.numbers, 'stopNumber');
    const fields = { From: PHONE, Body: 'STOP', AccountSid: settings.accountSid, MessageSid: `SM${'a'.repeat(32)}` };
    expect((await s.post({ fields })).status).toBe(200);
    await s.h.readyToText();
    const again = await s.post({ fields });
    expect(again.status).toBe(200);
    await expect(again.text()).resolves.toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(stop).toHaveBeenCalledTimes(1);
    expect((await s.h.reachSettings.get(ALICE))?.channels.texts).toBe(true);
    await s.post({ fields: { ...fields, MessageSid: `SM${'b'.repeat(32)}` } });
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('acts once on two copies of one message that arrive at the same time', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const real = s.h.numbers.stopNumber.bind(s.h.numbers);
    const stop = jest.spyOn(s.h.numbers, 'stopNumber').mockImplementation(async phone => {
      await gate;
      return real(phone);
    });
    const fields = { From: PHONE, Body: 'STOP', AccountSid: settings.accountSid, MessageSid: `SM${'c'.repeat(32)}` };
    const first = s.post({ fields });
    const second = s.post({ fields });
    const settled = await Promise.race([
      first,
      second,
      new Promise(resolve => setTimeout(() => resolve('waiting'), 2000)),
    ]);
    release();
    const responses = await Promise.all([first, second]);
    expect(settled).not.toBe('waiting');
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(s.h.activity.filter(row => row.tool_name === 'delivery.sms_stop')).toHaveLength(1);
  });

  it('a message that failed to be handled can be sent again', async () => {
    const real = s.h.numbers.stopNumber.bind(s.h.numbers);
    const stop = jest
      .spyOn(s.h.numbers, 'stopNumber')
      .mockImplementationOnce(() => Promise.reject(new Error('database away')))
      .mockImplementation(real);
    const fields = { From: PHONE, Body: 'STOP', AccountSid: settings.accountSid, MessageSid: `SM${'d'.repeat(32)}` };
    expect((await s.post({ fields })).status).toBe(500);
    expect((await s.post({ fields })).status).toBe(200);
    expect(stop).toHaveBeenCalledTimes(2);
    expect((await s.h.reachSettings.get(ALICE))?.channels.texts).toBe(false);
  });

  it('ignores every other reply: no change, and no answer written back', async () => {
    for (const body of ['yes', 'START', 'what is this', 'please stop', 'HELP']) {
      const response = await s.post({ fields: { From: PHONE, Body: body } });
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
    expect((await s.h.reachSettings.get(ALICE))?.channels.texts).toBe(true);
    expect(s.h.sent).toEqual([]);
  });

  it('an unsigned STOP does nothing', async () => {
    const response = await s.post({ fields: { From: PHONE, Body: 'STOP' }, sign: false });
    expect(response.status).toBe(403);
    expect((await s.h.reachSettings.get(ALICE))?.channels.texts).toBe(true);
    expect(s.h.activity).toEqual([]);
  });

  it('a signed request for another Twilio account does nothing', async () => {
    const response = await s.post({ fields: { From: PHONE, Body: 'STOP', AccountSid: `AC${'3'.repeat(32)}` } });
    expect(response.status).toBe(403);
    expect((await s.h.reachSettings.get(ALICE))?.channels.texts).toBe(true);
  });

  it('a STOP from a number nobody has changes nothing', async () => {
    const response = await s.post({ fields: { From: '+15550177', Body: 'STOP' } });
    expect(response.status).toBe(200);
    expect((await s.h.reachSettings.get(ALICE))?.channels.texts).toBe(true);
  });
});
