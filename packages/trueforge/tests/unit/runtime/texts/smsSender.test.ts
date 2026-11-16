import winston from 'winston';

import { TEST_WORDS } from '../../../../src/runtime/delivery/deliveryChannel';
import { createDeliveryService } from '../../../../src/runtime/delivery/deliveryService';
import { createSmsSender } from '../../../../src/runtime/texts/smsSender';
import {
  deliveryTextLimits,
  MAX_TEST_TEXTS_PER_HOUR,
  MAX_TEXTS_PER_NUMBER_PER_DAY,
  MAX_TEXTS_PER_PERSON_PER_DAY,
} from '../../../../src/runtime/texts/textLimits';
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

  it('Full texts carry a reminder’s words', async () => {
    const h = await textsHarness({ assistantName: 'Mannie' });
    await h.readyToText({ mode: 'full' });
    await h.deliveries.deliver(nudge('Pay the electric bill before Friday at 5pm.', 'reminder'));
    expect(h.sent[0]?.body).toBe('Mannie: Pay the electric bill before Friday at 5pm.');
    // An amount is fine, but a phone number is never sent in Full.
    await h.deliveries.deliver(nudge('Pay the $48 bill.', 'reminder'));
    expect(h.sent[1]?.body).toBe('Mannie: Pay the $48 bill.');
    await h.deliveries.deliver(nudge('Call 555 010 0199 about the bill.', 'reminder'));
    expect(h.sent[2]?.body).toBe('Mannie: a reminder is due. Open the app to see it.');
  });

  it('Full texts never carry what the assistant noticed, which is worded by the model and stays in the app', async () => {
    const h = await textsHarness({ assistantName: 'Mannie' });
    await h.readyToText({ mode: 'full' });
    const delivery = await h.deliveries.deliver(nudge('The model says: reply YES to pay now.'));
    expect(h.sent[0]?.body).toBe('Mannie: something needs you. Open the app to see it.');
    expect(delivery.attempts.find(row => row.channel === 'sms')?.detail).toBe(
      'Private text: what your assistant noticed is shown only in the app, so only the kind of thing was sent.',
    );
  });

  it('sends a Full reminder that is not plain words in Private words, and says so with the next step', async () => {
    const h = await textsHarness({ assistantName: 'Mannie' });
    await h.readyToText({ mode: 'full' });
    const delivery = await h.deliveries.deliver(
      nudge('Your parcel is held. Pay the fee at https://parcel.example.invalid now.', 'reminder'),
    );
    expect(h.sent[0]?.body).toBe('Mannie: a reminder is due. Open the app to see it.');
    expect(delivery.attempts.find(row => row.channel === 'sms')?.detail).toBe(
      'Private text: "https://parcel.example.invalid" is not a word a text may carry, so only the kind of thing was sent. A Full text carries common words, times, dates, amounts, short codes and the words you add, with at most 6 digits in all. To get this message by text, add the word under Words Aman may text in Settings, Reach me, or write it in common words. The whole message is in the app.',
    );
  });

  it('names the first word that held a Full text back, and sends it in Full once the person adds that word', async () => {
    const h = await textsHarness({ assistantName: 'Mannie' });
    await h.readyToText({ mode: 'full' });
    const first = await h.deliveries.deliver(nudge('Call Patel at 3pm. Bring the card.', 'reminder'));
    expect(h.sent[0]?.body).toBe('Mannie: a reminder is due. Open the app to see it.');
    expect(first.attempts.find(row => row.channel === 'sms')?.detail).toMatch(/^Private text: "patel" is not a word/);
    await h.contacts.addWord({ ...ALICE, word: 'patel', max: 200, now: new Date() });
    await h.deliveries.deliver(nudge('Call Patel at 3pm. Bring the card.', 'reminder'));
    expect(h.sent[1]?.body).toBe('Mannie: Call Patel at 3pm. Bring the card.');
  });

  it('ignores a stored word that is a web ending, so a stored list can never let one through', async () => {
    const h = await textsHarness({ assistantName: 'Mannie' });
    await h.readyToText({ mode: 'full' });
    await h.contacts.addWord({ ...ALICE, word: 'com', max: 200, now: new Date() });
    await h.deliveries.deliver(nudge('Visit evil. com', 'reminder'));
    expect(h.sent[0]?.body).toBe('Mannie: a reminder is due. Open the app to see it.');
  });

  it('sends only the fixed test words in Full for a test, never other words a test delivery carries', async () => {
    const h = await textsHarness({ assistantName: 'Mannie' });
    await h.readyToText({ mode: 'full' });
    await h.deliveries.deliver({ ...nudge(TEST_WORDS), kind: 'note', test: 'sms' });
    await h.deliveries.deliver({ ...nudge('The model says: reply YES.'), kind: 'note', test: 'sms' });
    expect(h.sent.map(text => text.body)).toEqual([
      `Mannie: ${TEST_WORDS}`,
      'Mannie: a note is waiting. Open the app to see it.',
    ]);
  });

  it('counts a Try it test toward the button’s own limit in the same claim, and says when to try again', async () => {
    const h = await textsHarness();
    await h.readyToText();
    const test = { ...nudge('A test.'), kind: 'note' as const, test: 'sms' as const };
    for (let press = 0; press < MAX_TEST_TEXTS_PER_HOUR; press += 1) {
      await h.deliveries.deliver(test);
    }
    const refused = await h.deliveries.deliver(test);
    expect(refused.attempts.find(row => row.channel === 'sms')).toMatchObject({
      outcome: 'skipped',
      detail: 'That was 3 test texts this hour. Wait 60 minutes, then try again.',
    });
    expect(h.sent).toHaveLength(MAX_TEST_TEXTS_PER_HOUR);
    // The refused test counted toward no day's limit either.
    const day = deliveryTextLimits({ owner: ALICE, phone: PHONE, settings: h.limits });
    await expect(
      h.contacts.claimTextSends({ limits: [{ ...day.person, max: MAX_TEST_TEXTS_PER_HOUR + 1 }], now: h.clock.now }),
    ).resolves.toEqual({ ok: true });
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

  it('sends at most a day’s texts to one number, however many people confirmed it', async () => {
    const h = await textsHarness();
    const bob = { tenant_id: 'default', created_by: 'bob' };
    await h.readyToText();
    await h.readyToText({ owner: bob });
    for (let index = 0; index < 20; index += 1) {
      await h.deliveries.deliver(nudge(BILL_TEXT));
      await h.deliveries.deliver({ ...nudge(BILL_TEXT), ...bob });
    }
    expect(h.sent).toHaveLength(MAX_TEXTS_PER_NUMBER_PER_DAY);
    const over = await h.deliveries.deliver({ ...nudge(BILL_TEXT), ...bob });
    expect(over.attempts.find(row => row.channel === 'sms')).toMatchObject({
      outcome: 'skipped',
      detail: `This number had ${String(MAX_TEXTS_PER_NUMBER_PER_DAY)} texts today, the most for one number, so no text was sent. Texts start again in about 24 hours. Until then, see new items in the app.`,
    });
  });

  it('sends at most the server’s day of texts across everyone, as the owner set it', async () => {
    const h = await textsHarness({ maxTextsPerDay: 5 });
    const bob = { tenant_id: 'default', created_by: 'bob' };
    await h.readyToText();
    await h.readyToText({ owner: bob, phone: '+15550122' });
    for (let index = 0; index < 3; index += 1) {
      await h.deliveries.deliver(nudge(BILL_TEXT));
      await h.deliveries.deliver({ ...nudge(BILL_TEXT), ...bob });
    }
    expect(h.sent).toHaveLength(5);
    const over = await h.deliveries.deliver(nudge(BILL_TEXT));
    expect(over.attempts.find(row => row.channel === 'sms')).toMatchObject({
      outcome: 'skipped',
      detail:
        'This server sent the most texts it may send in one day, so no text was sent. Texts start again in about 24 hours. Until then, see new items in the app.',
    });
  });

  it('a text the server’s day refuses counts toward no one, so texts start again as soon as the server’s day does', async () => {
    const h = await textsHarness({ maxTextsPerDay: 5 });
    const bob = { tenant_id: 'default', created_by: 'bob' };
    await h.readyToText({ owner: bob, phone: '+15550122' });
    await h.readyToText();
    for (let index = 0; index < 5; index += 1) {
      await h.deliveries.deliver({ ...nudge(BILL_TEXT), ...bob });
    }
    h.clock.now = new Date(h.clock.now.getTime() + 12 * 60 * 60_000);
    for (let index = 0; index < MAX_TEXTS_PER_PERSON_PER_DAY; index += 1) {
      const refused = await h.deliveries.deliver(nudge(BILL_TEXT));
      expect(refused.attempts.find(row => row.channel === 'sms')?.detail).toMatch(/^This server sent the most texts/);
    }
    expect(h.sent).toHaveLength(5);
    // The number's day did not grow either, so nobody else who has it is held back.
    await expect(
      h.contacts.claimTextSends({
        limits: [{ ...deliveryTextLimits({ owner: ALICE, phone: PHONE, settings: h.limits }).number, max: 1 }],
        now: h.clock.now,
      }),
    ).resolves.toEqual({ ok: true });
    h.clock.now = new Date(h.clock.now.getTime() + 12 * 60 * 60_000 + 60_000);
    const next = await h.deliveries.deliver(nudge(BILL_TEXT));
    expect(next.attempts.find(row => row.channel === 'sms')?.outcome).toBe('sent');
    expect(h.sent).toHaveLength(6);
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
    expect(long.sent[0]?.body).toBe('Juniper the very: something needs you. Open the app to see it.');
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
    const delivery = await h.deliveries.deliver({ ...nudge('A test.'), test: 'in_app' });
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

describe('which limit refused a text', () => {
  it('is told by the limit’s key, so a store that hands back a copy of the limit is read the same', async () => {
    const at = new Date('2026-11-06T10:00:00.000Z');
    const sender = createSmsSender({
      contacts: {
        listWords: () => Promise.resolve([]),
        get: () =>
          Promise.resolve({
            phone: PHONE,
            mode: 'private',
            confirmed_at: at.toISOString(),
            opted_out_at: null,
            pending_phone: null,
            code_hash: null,
            code_salt: null,
            code_key_id: null,
            code_expires_at: null,
            code_attempts: 0,
          }),
        // The refusing limit comes back as a copy, as it would after a round trip through a database.
        claimTextSends: ({ limits }) => {
          const last = limits.at(-1);
          return Promise.resolve(
            last === undefined
              ? { ok: true }
              : { ok: false, refused: { ...last }, window_started_at: at.toISOString() },
          );
        },
        forgetTextSends: () => Promise.resolve(),
      },
      reachSettings: {
        get: () =>
          Promise.resolve({
            ...defaultReachSettings('UTC'),
            channels: { ...defaultReachSettings('UTC').channels, texts: true },
          }),
      },
      personalization: { getProfile: () => Promise.resolve(undefined) },
      provider: { send: () => Promise.resolve({ outcome: 'sent' }) },
      limits: { number_key: 'secret', max_texts_per_day: 500 },
      textNumbers: { stopNumber: () => Promise.resolve(0) },
      now: () => at,
    });
    const delivery = {
      id: 'd1',
      kind: 'note' as const,
      level: 'nudge' as const,
      text: 'A test.',
      reason: 'A test.',
      link: null,
      created_at: at.toISOString(),
      seen_at: null,
      attempts: [],
    };
    const [tested] = await sender.send({ delivery, ...ALICE, test: true });
    expect(tested?.detail).toBe('That was 3 test texts this hour. Wait 60 minutes, then try again.');
  });
});
