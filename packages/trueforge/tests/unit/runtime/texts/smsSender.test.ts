import winston from 'winston';

import { createDeliveryService } from '../../../../src/runtime/delivery/deliveryService';
import { privatePhrase, textBody } from '../../../../src/runtime/texts/textWords';
import type { Delivery, DeliveryKind } from '../../../../src/schemas/deliveries';
import { defaultReachSettings } from '../../../../src/schemas/reach';
import { ALICE, PHONE, textsHarness } from '../../../fixtures/textsHarness';

const BILL_TEXT = 'Your electric bill of $482.10 is due Friday, from Dana Reyes at Northwind Power.';
const MAIL_TEXT = 'Subject: URGENT wire transfer. Hi Dana, please confirm the account ending 4417.';

function nudge(text: string, kind: 'nudge' | 'reminder' = 'nudge') {
  return {
    ...ALICE,
    kind,
    level: 'nudge' as const,
    text,
    reason: 'A bill is due soon.',
    link: null,
  };
}

describe('texts as a channel of the delivery layer', () => {
  it('sends nothing on a new install: no settings, no number, nothing is texted', async () => {
    const h = await textsHarness();
    const delivery = await h.deliveries.deliver(nudge(BILL_TEXT));
    expect(h.sent).toEqual([]);
    expect(delivery.attempts.map(attempt => attempt.channel)).toEqual(['in_app']);
  });

  it('sends nothing to a number that is not confirmed, and records why', async () => {
    const h = await textsHarness();
    await h.numbers.sendCode({ owner: ALICE, phone: PHONE });
    h.sent.length = 0;
    const settings = defaultReachSettings('UTC');
    await h.reachSettings.put({ ...ALICE, settings: { ...settings, channels: { ...settings.channels, texts: true } } });
    const delivery = await h.deliveries.deliver(nudge(BILL_TEXT));
    expect(h.sent).toEqual([]);
    const attempt = delivery.attempts.find(row => row.channel === 'sms');
    expect(attempt?.outcome).toBe('skipped');
    expect(attempt?.detail).toContain('not confirmed');
  });

  it('sends nothing to a confirmed number while texts are switched off', async () => {
    const h = await textsHarness();
    await h.readyToText();
    await h.reachSettings.put({ ...ALICE, settings: defaultReachSettings('UTC') });
    const delivery = await h.deliveries.deliver(nudge(BILL_TEXT));
    expect(h.sent).toEqual([]);
    expect(delivery.attempts.map(attempt => attempt.channel)).toEqual(['in_app']);
  });

  it('keeps a note in the app: no text', async () => {
    const h = await textsHarness();
    await h.readyToText();
    await h.deliveries.deliver({ ...nudge(BILL_TEXT), kind: 'note', level: 'note' });
    expect(h.sent).toEqual([]);
  });

  it('Private texts carry no names, amounts or mail text, only the kind of thing', async () => {
    const h = await textsHarness({ assistantName: 'Mannie' });
    await h.readyToText({ mode: 'private' });
    await h.deliveries.deliver({ ...nudge(BILL_TEXT), reason: MAIL_TEXT });
    await h.deliveries.deliver(nudge(MAIL_TEXT, 'reminder'));
    expect(h.sent.map(text => text.to)).toEqual([PHONE, PHONE]);
    expect(h.sent.map(text => text.body)).toEqual([
      'Mannie: something needs you. Open the app to see it.',
      'Mannie: a reminder is due. Open the app to see it.',
    ]);
    for (const { body } of h.sent) {
      expect(body).not.toMatch(/Dana|Reyes|Northwind|\$|482|Friday|URGENT|wire|4417|electric/);
    }
  });

  it('Full texts carry the one-sentence message', async () => {
    const h = await textsHarness({ assistantName: 'Mannie' });
    await h.readyToText({ mode: 'full' });
    await h.deliveries.deliver(nudge(BILL_TEXT));
    expect(h.sent[0]?.body).toBe(`Mannie: ${BILL_TEXT}`);
  });

  function delivery(text: string): Delivery {
    return {
      id: 'd1',
      kind: 'nudge',
      level: 'nudge',
      text,
      reason: 'A test.',
      link: null,
      created_at: '2026-11-06T10:00:00.000Z',
      seen_at: null,
      attempts: [],
    };
  }

  /** Plain characters that each take one place in a text, so two text segments hold 306 of them. */
  const ONE_PLACE = /^[A-Za-z0-9 !"#$%&'()*+,\-./:;<=>?@_]*$/;

  it('cuts a long Full message at a word, within two text segments, name included', () => {
    const body = textBody({ name: 'Mannie', delivery: delivery(`${'word '.repeat(200)}end`), mode: 'full' });
    expect(body.length).toBeLessThanOrEqual(306);
    expect(body.endsWith('word...')).toBe(true);
    expect(body).toMatch(ONE_PLACE);
  });

  it('writes a Full message in plain characters, so it is not sent in the costlier long form', () => {
    const body = textBody({
      name: 'Mannie',
      delivery: delivery('Café “bill” — due… {soon} [ok] ~ |x| ^ `y` \\ 🎉 naïve'),
      mode: 'full',
    });
    expect(body).toBe('Mannie: Cafe "bill" - due... (soon) (ok) - /x/ \'y\' / naive');
    expect(body).toMatch(ONE_PLACE);
  });

  it('keeps a long or unusual assistant name short and plain in a text', async () => {
    const h = await textsHarness({ assistantName: `Call 555 0199 now: your bank ${'x'.repeat(400)}` });
    await h.readyToText();
    await h.deliveries.deliver(nudge(BILL_TEXT));
    expect(h.sent[0]?.body).toBe('Call now your bank x: something needs you. Open the app to see it.');
    const plain = await textsHarness({ assistantName: '🎉🎉' });
    await plain.readyToText();
    await plain.deliveries.deliver(nudge(BILL_TEXT));
    expect(plain.sent[0]?.body).toBe('Your assistant: something needs you. Open the app to see it.');
  });

  it('takes the assistant name from the person’s settings, never a fixed one', async () => {
    const named = await textsHarness({ assistantName: 'Juniper' });
    await named.readyToText();
    await named.deliveries.deliver(nudge(BILL_TEXT));
    expect(named.sent[0]?.body.startsWith('Juniper: ')).toBe(true);
    const unnamed = await textsHarness({ assistantName: null });
    await unnamed.readyToText();
    await unnamed.deliveries.deliver(nudge(BILL_TEXT));
    expect(unnamed.sent[0]?.body).toBe('Your assistant: something needs you. Open the app to see it.');
    expect(unnamed.sent[0]?.body).not.toContain('Mannie');
  });

  it('words every kind with no content', () => {
    const kinds: DeliveryKind[] = ['reminder', 'note', 'nudge', 'approval_waiting'];
    for (const kind of kinds) {
      expect(privatePhrase(kind)).toMatch(/^[a-z ]+$/);
    }
  });

  it('records each text as a channel attempt and in Activity, naming the number only by its last digits', async () => {
    const h = await textsHarness();
    await h.readyToText();
    const delivery = await h.deliveries.deliver(nudge(BILL_TEXT));
    const attempt = delivery.attempts.find(row => row.channel === 'sms');
    expect(attempt).toMatchObject({ outcome: 'sent', target: 'number ending 0111' });
    expect(attempt?.detail).toContain('Private');
    const row = h.activity.find(entry => entry.tool_name === 'delivery.sms');
    expect(row?.description).toBe(`Tried a text message: sent. ${attempt?.detail ?? ''}`);
    expect(JSON.stringify(h.activity)).not.toContain(PHONE);
  });

  it('records a failed text and still delivers to the app', async () => {
    const h = await textsHarness();
    await h.readyToText();
    h.next.result = { outcome: 'failed', failure: 'unreachable' };
    const delivery = await h.deliveries.deliver(nudge(BILL_TEXT));
    expect(delivery.attempts.find(row => row.channel === 'sms')?.outcome).toBe('failed');
    expect(delivery.attempts.find(row => row.channel === 'in_app')?.outcome).toBe('sent');
  });

  it('turns texts off when the phone company says the number replied STOP', async () => {
    const h = await textsHarness();
    await h.readyToText();
    h.next.result = { outcome: 'failed', failure: 'opted_out' };
    await h.deliveries.deliver(nudge(BILL_TEXT));
    expect((await h.reachSettings.get(ALICE))?.channels.texts).toBe(false);
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({ confirmed: false, opted_out: true });
    h.sent.length = 0;
    await h.deliveries.deliver(nudge(BILL_TEXT));
    expect(h.sent).toEqual([]);
  });

  it('a test of one channel does not try the others', async () => {
    const h = await textsHarness();
    await h.readyToText();
    const delivery = await h.deliveries.deliver({ ...nudge('A test.'), only_channels: [] });
    expect(delivery.attempts.map(attempt => attempt.channel)).toEqual(['in_app']);
    expect(h.sent).toEqual([]);
  });

  it('says so when the server has no provider but the person had texts on', async () => {
    const h = await textsHarness({ provider: false });
    await h.readyToText();
    const delivery = await h.deliveries.deliver(nudge(BILL_TEXT));
    expect(delivery.attempts.find(row => row.channel === 'sms')).toMatchObject({ outcome: 'skipped' });
  });
});

describe('a sender that throws', () => {
  it('is recorded under its own channel, and the other senders and the app still deliver', async () => {
    const h = await textsHarness();
    const service = createDeliveryService({
      store: h.deliveryStore,
      senders: [
        { channel: 'sms', send: () => Promise.reject(new Error('provider exploded +15550111')) },
        { channel: 'web_push', send: () => Promise.resolve([]) },
      ],
      audit: { record: () => Promise.resolve() },
      logger: winston.createLogger({ silent: true }),
    });
    const delivery = await service.deliver(nudge(BILL_TEXT));
    expect(delivery.attempts.map(attempt => [attempt.channel, attempt.outcome])).toEqual([
      ['in_app', 'sent'],
      ['sms', 'failed'],
    ]);
    expect(JSON.stringify(delivery.attempts)).not.toContain('5550111');
  });
});
