import { OpenAPIHono } from '@hono/zod-openapi';

import winston from 'winston';
import { createReachRouter } from '../../../src/apis/reach';
import { createTextNumberRouter } from '../../../src/apis/textNumber';
import type { RequestContext } from '../../../src/auth/identity';
import { NoticingStore } from '../../../src/db/noticingStore';
import { reachChannelsFor } from '../../../src/runtime/noticing/reachChannels';
import { deliveryTextLimits, MAX_TEST_TEXTS_PER_HOUR, testTextLimit } from '../../../src/runtime/texts/textLimits';
import { RequestErrorResponseSchema } from '../../../src/schemas/errors';
import { defaultReachSettings } from '../../../src/schemas/reach';
import { GetTextStatusResponseSchema } from '../../../src/schemas/textMessages';
import { ALICE, PHONE, textsHarness } from '../../fixtures/textsHarness';

function person(id: string): RequestContext {
  return { tenant_id: 'default', subject: { id, type: 'user', display_name: id }, roles: [], user_credential: null };
}

async function build({
  provider = true,
  maxTextsPerDay,
  textsOffAfterCheck = false,
  stopAfterCheck = false,
}: { provider?: boolean; maxTextsPerDay?: number; textsOffAfterCheck?: boolean; stopAfterCheck?: boolean } = {}) {
  let checked = false;
  const h = await textsHarness({ provider, ...(maxTextsPerDay === undefined ? {} : { maxTextsPerDay }) });
  const channels = reachChannelsFor({
    twilio: provider ? { accountSid: 'AC' } : undefined,
    voice: 'ready',
    numberProblem: undefined,
    viewer: 'person',
  });
  const app = new OpenAPIHono();
  app.route(
    '/texts',
    createTextNumberRouter({
      textNumbers: h.numbers,
      available: () => channels.texts.available,
      resolveRequestContext: () => person('alice'),
    }),
  );
  app.route(
    '/reach',
    createReachRouter({
      reachStore: textsOffAfterCheck
        ? {
            listOwners: () => h.reachSettings.listOwners(),
            put: input => h.reachSettings.put(input),
            importSettings: input => h.reachSettings.importSettings(input),
            // As if the person switched texts off in another tab just after the route read their settings.
            get: async owner => {
              const settings = await h.reachSettings.get(owner);
              if (settings !== undefined) {
                await h.reachSettings.put({
                  ...owner,
                  settings: { ...settings, channels: { ...settings.channels, texts: false } },
                });
              }
              return settings;
            },
          }
        : h.reachSettings,
      textContacts: stopAfterCheck
        ? {
            // As if the number replied STOP just after the route checked it, the first time only.
            get: async owner => {
              const contact = await h.contacts.get(owner);
              if (!checked) {
                checked = true;
                await h.numbers.stopNumber(PHONE);
              }
              return contact;
            },
          }
        : h.contacts,
      noticingStore: new NoticingStore(h.db),
      deliveryService: h.deliveries,
      channels: () => channels,
      isInstanceOwner: () => true,
      memories: () => Promise.resolve([]),
      resolveRequestContext: () => person('alice'),
      logger: winston.createLogger({ silent: true }),
      now: () => h.clock.now,
    }),
  );
  const call = (path: string, init?: { method: string; body?: unknown }) =>
    app.request(path, {
      method: init?.method ?? 'GET',
      headers: { 'content-type': 'application/json' },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  return { h, call };
}

const statusOf = async (response: Response) => GetTextStatusResponseSchema.parse(await response.json()).data;
const message = async (response: Response) => RequestErrorResponseSchema.parse(await response.json()).error.message;

describe('text number routes', () => {
  it('starts with no number, nothing confirmed and Private chosen', async () => {
    const { call } = await build();
    expect(await statusOf(await call('/texts'))).toEqual({
      phone: null,
      confirmed: false,
      mode: 'private',
      opted_out: false,
      pending_phone: null,
      private_preview: 'Mannie: a reminder is due. Open the app to see it.',
      code_pending: false,
      words: [],
    });
  });

  it('adds a word Aman may text, folds it, lists it, and takes it off again', async () => {
    const { call } = await build();
    const added = await call('/texts/words', { method: 'POST', body: { word: ' Patel ' } });
    expect(added.status).toBe(201);
    expect(await statusOf(added)).toMatchObject({ words: ['patel'] });
    expect(await statusOf(await call('/texts/words', { method: 'POST', body: { word: 'PATEL' } }))).toMatchObject({
      words: ['patel'],
    });
    const removed = await call('/texts/words/Patel', { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(await statusOf(removed)).toMatchObject({ words: [] });
  });

  it('refuses a word that is a web ending, a number word or not letters, and says what to do', async () => {
    const { call } = await build();
    for (const word of ['com', 'five', 'evil.com', 'a1', 'x'.repeat(30)]) {
      const refused = await call('/texts/words', { method: 'POST', body: { word } });
      expect([word, refused.status]).toEqual([word, 400]);
      expect(await message(refused)).toMatch(/letters|web ending|2 to 24/);
    }
  });

  it('stops at 200 words', async () => {
    const { h, call } = await build();
    for (let index = 0; index < 200; index += 1) {
      await h.contacts.addWord({
        ...ALICE,
        word: `w${'a'.repeat(1 + (index % 20))}${'b'.repeat(Math.floor(index / 20))}`,
        max: 200,
        now: new Date(),
      });
    }
    const full = await call('/texts/words', { method: 'POST', body: { word: 'extra' } });
    expect(full.status).toBe(409);
  });

  it('walks enter number, receive code, confirm, choose Full, then switch texts on', async () => {
    const { h, call } = await build();
    const sent = await call('/texts/code', { method: 'POST', body: { phone: '+1 555 011 1' } });
    expect(sent.status).toBe(201);
    expect(await statusOf(sent)).toMatchObject({ phone: '+15550111', confirmed: false, code_pending: true });
    const wrong = await call('/texts/confirm', { method: 'POST', body: { code: '000000' } });
    expect(wrong.status).toBe(400);
    expect(await message(wrong)).toBe('That code is not right. You have 4 tries left.');
    const right = await call('/texts/confirm', { method: 'POST', body: { code: '111111' } });
    expect(right.status).toBe(200);
    expect(await statusOf(right)).toMatchObject({ confirmed: true });
    expect(await statusOf(await call('/texts', { method: 'PUT', body: { mode: 'full' } }))).toMatchObject({
      mode: 'full',
    });
    const on = await call('/reach', {
      method: 'PUT',
      body: { settings: { ...defaultReachSettings('UTC'), channels: { texts: true, calls: false } } },
    });
    expect(on.status).toBe(200);
    expect((await h.reachSettings.get(ALICE))?.channels.texts).toBe(true);
  });

  it('refuses to switch texts on before the number is confirmed', async () => {
    const { call } = await build();
    const settings = { ...defaultReachSettings('UTC'), channels: { texts: true, calls: false } };
    expect((await call('/reach', { method: 'PUT', body: { settings } })).status).toBe(400);
    await call('/texts/code', { method: 'POST', body: { phone: '+15550111' } });
    const pending = await call('/reach', { method: 'PUT', body: { settings } });
    expect(pending.status).toBe(400);
    expect(await message(pending)).toContain('Confirm your number first');
  });

  it('says what to do for a bad number, a rate limit and a server with no provider', async () => {
    const { call } = await build();
    const bad = await call('/texts/code', { method: 'POST', body: { phone: '555-0111' } });
    expect(bad.status).toBe(400);
    expect(await message(bad)).toContain('country code');
    for (let n = 0; n < 3; n += 1) {
      await call('/texts/code', { method: 'POST', body: { phone: '+15550111' } });
    }
    const limited = await call('/texts/code', { method: 'POST', body: { phone: '+15550111' } });
    expect(limited.status).toBe(429);
    expect(await message(limited)).toMatch(/Wait \d+ minutes/);
    const none = await build({ provider: false });
    const refused = await none.call('/texts/code', { method: 'POST', body: { phone: '+15550111' } });
    expect(refused.status).toBe(409);
    expect(await message(refused)).toContain('Text messages page');
  });

  it('counts the wait in plain words, down to one minute', async () => {
    const { h, call } = await build();
    for (let n = 0; n < 3; n += 1) {
      await call('/texts/code', { method: 'POST', body: { phone: `+1555011${String(n)}` } });
    }
    h.clock.now = new Date(h.clock.now.getTime() + 59 * 60_000 + 30_000);
    const limited = await call('/texts/code', { method: 'POST', body: { phone: '+15550119' } });
    expect(await message(limited)).toBe('Too many codes were sent. Wait 1 minute, then ask for another.');
  });

  it('says what to do when the code could not be sent, without telling whether the number replied STOP', async () => {
    const { h, call } = await build();
    const cannot = 'That number cannot get texts from this server. Check the number, then try again.';
    const cases = [
      { failure: 'opted_out', words: cannot },
      { failure: 'invalid_number', words: cannot },
      {
        failure: 'not_accepted',
        words: 'Twilio did not accept this server’s sign-in details. Ask whoever runs Aman to check them.',
      },
      { failure: 'unreachable', words: 'Twilio could not be reached. Try again in a few minutes.' },
    ] as const;
    for (const [index, { failure, words }] of cases.entries()) {
      h.next.result = { outcome: 'failed', failure };
      const response = await call('/texts/code', { method: 'POST', body: { phone: `+1555012${String(index)}` } });
      expect(response.status).toBe(502);
      expect(await message(response)).toBe(words);
      h.clock.now = new Date(h.clock.now.getTime() + 61 * 60_000);
    }
  });

  it('voids a code after too many wrong tries and says so', async () => {
    const { call } = await build();
    await call('/texts/code', { method: 'POST', body: { phone: '+15550111' } });
    const answers: Response[] = [];
    for (let n = 0; n < 5; n += 1) {
      answers.push(await call('/texts/confirm', { method: 'POST', body: { code: '000000' } }));
    }
    const final = answers.at(-1);
    if (final === undefined) {
      throw new Error('No answer came back.');
    }
    expect(await message(final)).toContain('code is void');
    expect((await call('/texts/confirm', { method: 'POST', body: { code: '111111' } })).status).toBe(400);
  });

  it('removing the number switches texts off', async () => {
    const { h, call } = await build();
    await h.readyToText();
    expect((await call('/texts', { method: 'DELETE' })).status).toBe(200);
    expect(await statusOf(await call('/texts'))).toMatchObject({ phone: null });
    expect((await h.reachSettings.get(ALICE))?.channels.texts).toBe(false);
  });

  it('refuses a choice of words before there is a number', async () => {
    const { call } = await build();
    expect((await call('/texts', { method: 'PUT', body: { mode: 'full' } })).status).toBe(409);
  });
});

describe('the other test buttons', () => {
  it('a push or in-app test never sends a text, even with texts on', async () => {
    const { h, call } = await build();
    await h.readyToText();
    expect((await call('/reach/test', { method: 'POST', body: { channel: 'push' } })).status).toBe(201);
    expect((await call('/reach/test', { method: 'POST', body: { channel: 'in_app' } })).status).toBe(201);
    expect(h.sent).toEqual([]);
  });
});

describe('the text test button', () => {
  it('texts the confirmed number, and only by the text channel', async () => {
    const { h, call } = await build();
    await h.readyToText();
    const response = await call('/reach/test', { method: 'POST', body: { channel: 'text' } });
    expect(response.status).toBe(201);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.body).toContain('Open the app to see it.');
  });

  it('asks the person to confirm and switch on first, and says so when sending fails', async () => {
    const { h, call } = await build();
    const early = await call('/reach/test', { method: 'POST', body: { channel: 'text' } });
    expect(early.status).toBe(409);
    expect(await message(early)).toBe('Confirm your number and switch texts on first, then try again.');
    await h.readyToText();
    h.next.result = { outcome: 'failed', failure: 'invalid_number' };
    const failed = await call('/reach/test', { method: 'POST', body: { channel: 'text' } });
    expect(failed.status).toBe(502);
    expect(await message(failed)).toContain('Check it in Settings');
  });

  it('sends at most a few test texts an hour, then says how long to wait', async () => {
    const { h, call } = await build();
    await h.readyToText();
    const statuses: number[] = [];
    for (let press = 0; press < 10; press += 1) {
      statuses.push((await call('/reach/test', { method: 'POST', body: { channel: 'text' } })).status);
    }
    expect(statuses).toEqual([201, 201, 201, 429, 429, 429, 429, 429, 429, 429]);
    expect(h.sent).toHaveLength(MAX_TEST_TEXTS_PER_HOUR);
    // The refused tests counted nowhere: the day's count for the person holds only the tests that went out.
    const day = deliveryTextLimits({ owner: ALICE, phone: PHONE, settings: h.limits });
    await expect(
      h.contacts.claimTextSends({ limits: [{ ...day.person, max: MAX_TEST_TEXTS_PER_HOUR + 1 }], now: h.clock.now }),
    ).resolves.toEqual({ ok: true });
    h.clock.now = new Date(h.clock.now.getTime() + 20 * 60_000);
    const later = await call('/reach/test', { method: 'POST', body: { channel: 'text' } });
    expect(later.status).toBe(429);
    expect(await message(later)).toBe('That was 3 test texts this hour. Wait 40 minutes, then try again.');
    h.clock.now = new Date(h.clock.now.getTime() + 40 * 60_000);
    expect((await call('/reach/test', { method: 'POST', body: { channel: 'text' } })).status).toBe(201);
    expect(h.sent).toHaveLength(MAX_TEST_TEXTS_PER_HOUR + 1);
  });

  it('says when the day’s texts are used up, and keeps the test for later', async () => {
    const { h, call } = await build({ maxTextsPerDay: 1 });
    await h.readyToText();
    await h.deliveries.deliver({
      ...ALICE,
      kind: 'reminder',
      level: 'nudge',
      text: 'Water the plants',
      reason: 'Due.',
      link: null,
    });
    expect(h.sent).toHaveLength(1);
    const refused = await call('/reach/test', { method: 'POST', body: { channel: 'text' } });
    expect(refused.status).toBe(429);
    expect(await message(refused)).toBe(
      'This server sent the most texts it may send in one day, so no text was sent. Texts start again in about 24 hours.',
    );
    expect(h.sent).toHaveLength(1);
    // A limit of one still has room, so the refused test was not counted against the button.
    await expect(
      h.contacts.claimTextSends({ limits: [{ ...testTextLimit(ALICE), max: 1 }], now: h.clock.now }),
    ).resolves.toEqual({ ok: true });
  });

  it('asks the person to switch texts on when they were switched off between the check and the send', async () => {
    const { h, call } = await build({ textsOffAfterCheck: true });
    await h.readyToText();
    const response = await call('/reach/test', { method: 'POST', body: { channel: 'text' } });
    expect(response.status).toBe(409);
    expect(await message(response)).toBe('Confirm your number and switch texts on first, then try again.');
    expect(h.sent).toEqual([]);
  });

  it('asks the person to reply START when the number replied STOP between the check and the send', async () => {
    const { h, call } = await build({ stopAfterCheck: true });
    await h.readyToText();
    const response = await call('/reach/test', { method: 'POST', body: { channel: 'text' } });
    expect(response.status).toBe(409);
    expect(await message(response)).toBe(
      'This number replied STOP to the phone company. Reply START from that phone, then confirm the number again in Settings.',
    );
    expect(h.sent).toEqual([]);
  });

  it('sends the test in its own words when the person chose Full', async () => {
    const { h, call } = await build();
    await h.readyToText({ mode: 'full' });
    expect((await call('/reach/test', { method: 'POST', body: { channel: 'text' } })).status).toBe(201);
    expect(h.sent.at(-1)?.body).toMatch(/: This is a test, and it works if you can read this\.$/);
  });

  it('says texts are not set up, with the one thing to do, when there is no provider', async () => {
    const { call } = await build({ provider: false });
    const response = await call('/reach/test', { method: 'POST', body: { channel: 'text' } });
    expect(response.status).toBe(409);
    expect(await message(response)).toContain('follow the Text messages page in the Aman docs');
  });
});
