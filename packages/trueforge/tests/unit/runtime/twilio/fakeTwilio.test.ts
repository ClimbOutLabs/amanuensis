import { createTwilioCallProvider } from '../../../../src/runtime/calls/twilioCalls';
import { createTwilioSmsProvider } from '../../../../src/runtime/texts/smsProvider';
import { codeText } from '../../../../src/runtime/texts/textWords';
import { defaultReachSettings } from '../../../../src/schemas/reach';
import { ALICE as CALL_ALICE, PHONE as CALL_PHONE, callsHarness } from '../../../fixtures/callsHarness';
import { FAKE_ACCOUNT_SID, FAKE_AUTH_TOKEN, FAKE_NUMBER_SID, fakeTwilio } from '../../../fixtures/fakeTwilio';
import { ALICE, PHONE, textsHarness } from '../../../fixtures/textsHarness';

const FROM = '+15550100';
const WEBHOOK = 'https://aman.example.invalid';
const settings = {
  accountSid: FAKE_ACCOUNT_SID,
  authToken: FAKE_AUTH_TOKEN,
  fromNumber: FROM,
  webhookPublicUrl: WEBHOOK,
};

function nudge(text: string, kind: 'nudge' | 'reminder') {
  return { ...ALICE, kind, level: 'nudge' as const, text, reason: 'It is due.', link: null };
}

describe('what texts put on the wire to Twilio', () => {
  it('sends a Private text as To, From and the assistant’s words only', async () => {
    const twilio = fakeTwilio();
    const h = await textsHarness({
      assistantName: 'Mannie',
      smsProvider: createTwilioSmsProvider({ settings, fetchTwilio: twilio.fetchTwilio }),
    });
    await h.readyToText({ mode: 'private' });
    await h.deliveries.deliver(nudge('Pay Dana Reyes $482.10 by Friday.', 'reminder'));
    expect(twilio.requests).toEqual([
      {
        method: 'POST',
        resource: 'Messages.json',
        query: {},
        form: { To: PHONE, From: FROM, Body: 'Mannie: a reminder is due. Open the app to see it.' },
        signedIn: true,
      },
    ]);
  });

  it('sends a Full reminder with its own words, and the Private words for what was noticed', async () => {
    const twilio = fakeTwilio();
    const h = await textsHarness({
      assistantName: 'Mannie',
      smsProvider: createTwilioSmsProvider({ settings, fetchTwilio: twilio.fetchTwilio }),
    });
    await h.readyToText({ mode: 'full' });
    await h.deliveries.deliver(nudge('Pay the electric bill before Friday at 5pm.', 'reminder'));
    await h.deliveries.deliver(nudge('Your 3pm clashes with the school pickup.', 'nudge'));
    expect(twilio.requests.map(request => request.form)).toEqual([
      { To: PHONE, From: FROM, Body: 'Mannie: Pay the electric bill before Friday at 5pm.' },
      { To: PHONE, From: FROM, Body: 'Mannie: something needs you. Open the app to see it.' },
    ]);
  });

  it('sends the confirmation code to the number being confirmed, and nothing else', async () => {
    const twilio = fakeTwilio();
    const h = await textsHarness({
      smsProvider: createTwilioSmsProvider({ settings, fetchTwilio: twilio.fetchTwilio }),
    });
    await h.numbers.sendCode({ owner: ALICE, phone: PHONE });
    expect(twilio.requests).toEqual([
      {
        method: 'POST',
        resource: 'Messages.json',
        query: {},
        form: { To: PHONE, From: FROM, Body: codeText('111111') },
        signedIn: true,
      },
    ]);
  });

  it('makes no request at all while texts are off, the number is unconfirmed, or the item is only a note', async () => {
    const twilio = fakeTwilio();
    const h = await textsHarness({
      smsProvider: createTwilioSmsProvider({ settings, fetchTwilio: twilio.fetchTwilio }),
    });
    await h.deliveries.deliver(nudge('Pay the electric bill.', 'reminder'));
    await h.readyToText();
    await h.reachSettings.put({ ...ALICE, settings: defaultReachSettings('UTC') });
    await h.deliveries.deliver(nudge('Pay the electric bill.', 'reminder'));
    await h.readyToText();
    await h.deliveries.deliver({ ...nudge('Pay the electric bill.', 'nudge'), kind: 'note', level: 'note' });
    expect(twilio.requests).toEqual([]);
  });

  it('makes no further request once the person replied STOP', async () => {
    const twilio = fakeTwilio();
    const h = await textsHarness({
      smsProvider: createTwilioSmsProvider({ settings, fetchTwilio: twilio.fetchTwilio }),
    });
    await h.readyToText();
    await h.numbers.stopNumber(PHONE);
    await h.deliveries.deliver(nudge('Pay the electric bill.', 'reminder'));
    expect(twilio.requests).toEqual([]);
  });
});

describe('what pointing the number puts on the wire to Twilio', () => {
  const smsUrl = `${WEBHOOK}/twilio/sms`;

  it('looks up only this number, then sets only its incoming-text address, signed in as the account', async () => {
    const twilio = fakeTwilio({ numbers: [{ phone_number: FROM, sms_url: 'https://old.example/sms' }] });
    const result = await createTwilioSmsProvider({ settings, fetchTwilio: twilio.fetchTwilio }).pointNumberAt({
      smsUrl,
    });
    expect(result).toEqual({ result: 'updated', replaced_host: 'old.example' });
    expect(twilio.requests).toEqual([
      { method: 'GET', resource: 'IncomingPhoneNumbers.json', query: { PhoneNumber: FROM }, form: {}, signedIn: true },
      {
        method: 'POST',
        resource: `IncomingPhoneNumbers/${FAKE_NUMBER_SID}.json`,
        query: {},
        form: { SmsUrl: smsUrl, SmsMethod: 'POST' },
        signedIn: true,
      },
    ]);
  });

  it('sends no update when the number already points here', async () => {
    const twilio = fakeTwilio({ numbers: [{ phone_number: FROM, sms_url: smsUrl }] });
    const result = await createTwilioSmsProvider({ settings, fetchTwilio: twilio.fetchTwilio }).pointNumberAt({
      smsUrl,
    });
    expect(result).toEqual({ result: 'already_set' });
    expect(twilio.requests.map(request => request.method)).toEqual(['GET']);
  });
});

describe('what calls put on the wire to Twilio', () => {
  it('creates the call with the person’s number, ours, and both webhook addresses for the same call', async () => {
    const twilio = fakeTwilio();
    const h = await callsHarness({
      callProvider: createTwilioCallProvider({ settings, fetchTwilio: twilio.fetchTwilio }),
    });
    await h.readyToCall({ texts: false });
    await h.callDelivery();
    const [request, ...others] = twilio.requests;
    expect(others).toEqual([]);
    expect(request).toMatchObject({ method: 'POST', resource: 'Calls.json', query: {}, signedIn: true });
    const id = /^[0-9a-z]{26}$/.exec(new URL(request?.form['Url'] ?? '').searchParams.get('call') ?? '')?.[0];
    expect(id).toBeDefined();
    expect(request?.form).toEqual({
      To: CALL_PHONE,
      From: FROM,
      Url: `${WEBHOOK}/twilio/voice?call=${id}`,
      Method: 'POST',
      StatusCallback: `${WEBHOOK}/twilio/call-status?call=${id}`,
      StatusCallbackMethod: 'POST',
      Timeout: '25',
      TimeLimit: '660',
      MachineDetection: 'DetectMessageEnd',
      MachineDetectionTimeout: '30',
    });
    await h.close();
  });

  it('makes no request at all while calls are switched off, or when the item is not urgent enough to call', async () => {
    const twilio = fakeTwilio();
    const h = await callsHarness({
      smsProvider: createTwilioSmsProvider({ settings, fetchTwilio: twilio.fetchTwilio }),
      callProvider: createTwilioCallProvider({ settings, fetchTwilio: twilio.fetchTwilio }),
    });
    await h.readyToCall({ texts: false });
    const off = defaultReachSettings('UTC');
    await h.reachSettings.put({ ...CALL_ALICE, settings: { ...off, channels: { texts: false, calls: false } } });
    await h.callDelivery();
    await h.deliveries.deliver({
      ...CALL_ALICE,
      kind: 'note',
      level: 'note',
      text: 'Nothing urgent.',
      reason: 'It is a note.',
      link: null,
    });
    expect(twilio.requests).toEqual([]);
    await h.close();
  });
});
