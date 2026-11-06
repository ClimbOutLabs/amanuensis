import winston from 'winston';

import { createDeliveryService } from '../../../../src/runtime/delivery/deliveryService';
import { MAX_TEXTS_PER_PERSON_PER_DAY } from '../../../../src/runtime/texts/textLimits';
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

  it('sends a Full message that names a link in Private words, and says so', async () => {
    const h = await textsHarness({ assistantName: 'Mannie' });
    await h.readyToText({ mode: 'full' });
    const delivery = await h.deliveries.deliver(
      nudge('Your parcel is held. Pay the fee at https://parcel.example.invalid now.'),
    );
    expect(h.sent[0]?.body).toBe('Mannie: something needs you. Open the app to see it.');
    expect(delivery.attempts.find(row => row.channel === 'sms')?.detail).toBe(
      'Private text: the message named a link or a phone number, so only the kind of thing was sent.',
    );
  });

  it('sends at most a day’s texts to one person, reminders included, then says when they start again', async () => {
    const h = await textsHarness();
    await h.readyToText();
    for (let index = 0; index < MAX_TEXTS_PER_PERSON_PER_DAY; index += 1) {
      await h.deliveries.deliver(nudge(BILL_TEXT, index % 2 === 0 ? 'reminder' : 'nudge'));
    }
    expect(h.sent).toHaveLength(MAX_TEXTS_PER_PERSON_PER_DAY);
    h.clock.now = new Date(h.clock.now.getTime() + 3 * 60 * 60_000);
    const over = await h.deliveries.deliver(nudge(BILL_TEXT, 'reminder'));
    expect(h.sent).toHaveLength(MAX_TEXTS_PER_PERSON_PER_DAY);
    expect(over.attempts.find(row => row.channel === 'sms')).toMatchObject({
      outcome: 'skipped',
      detail: `You had ${String(MAX_TEXTS_PER_PERSON_PER_DAY)} texts today, the most for one day, so no text was sent. Texts start again in about 21 hours. Until then, see new items in the app.`,
    });
    expect(over.attempts.find(row => row.channel === 'in_app')?.outcome).toBe('sent');
    h.clock.now = new Date(h.clock.now.getTime() + 21 * 60 * 60_000);
    await h.deliveries.deliver(nudge(BILL_TEXT));
    expect(h.sent).toHaveLength(MAX_TEXTS_PER_PERSON_PER_DAY + 1);
  });

  it('counts a failed text toward the day, so a failing provider cannot be retried without end', async () => {
    const h = await textsHarness();
    await h.readyToText();
    h.next.result = { outcome: 'failed', failure: 'unreachable' };
    for (let index = 0; index < MAX_TEXTS_PER_PERSON_PER_DAY; index += 1) {
      await h.deliveries.deliver(nudge(BILL_TEXT));
    }
    h.next.result = { outcome: 'sent' };
    const over = await h.deliveries.deliver(nudge(BILL_TEXT));
    expect(over.attempts.find(row => row.channel === 'sms')?.outcome).toBe('skipped');
    expect(h.sent).toHaveLength(MAX_TEXTS_PER_PERSON_PER_DAY);
  });

  it('keeps a long or unusual assistant name short and plain in a text', async () => {
    const h = await textsHarness({ assistantName: `Call 555 0199 now: your bank ${'x'.repeat(400)}` });
    await h.readyToText();
    await h.deliveries.deliver(nudge(BILL_TEXT));
    expect(h.sent[0]?.body).toBe('Your assistant: something needs you. Open the app to see it.');
    const long = await textsHarness({ assistantName: `Juniper the ${'very '.repeat(80)}helpful` });
    await long.readyToText();
    await long.deliveries.deliver(nudge(BILL_TEXT));
    expect(long.sent[0]?.body).toBe('Juniper the very ver: something needs you. Open the app to see it.');
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
