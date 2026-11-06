import {
  MAX_CODES_PER_HOUR,
  MAX_CODES_PER_NUMBER_PER_DAY,
  MAX_CODES_PER_NUMBER_PER_HOUR,
  MAX_CODES_PER_PERSON_PER_DAY,
  MAX_CODES_PER_SERVER_PER_DAY,
} from '../../../../src/runtime/texts/textLimits';
import {
  CODE_TTL_MS,
  isOptOutWord,
  MAX_CODE_ATTEMPTS,
  normalizePhoneNumber,
} from '../../../../src/runtime/texts/textNumber';
import { ALICE, PHONE, textsHarness } from '../../../fixtures/textsHarness';

describe('phone numbers and opt-out words', () => {
  it('reads a number with the country code and rejects the rest', () => {
    expect(normalizePhoneNumber('+1 (555) 011-1')).toBe('+15550111');
    expect(normalizePhoneNumber('+1 555 0111 222')).toBe('+15550111222');
    expect(normalizePhoneNumber('555-0111')).toBeUndefined();
    expect(normalizePhoneNumber('+0123456789')).toBeUndefined();
    expect(normalizePhoneNumber('hello')).toBeUndefined();
  });

  it('knows every word Twilio treats as STOP, in any case, and nothing else', () => {
    for (const word of ['STOP', 'stop', ' Stop ', 'STOPALL', 'UNSUBSCRIBE', 'cancel', 'END', 'quit']) {
      expect(isOptOutWord(word)).toBe(true);
    }
    for (const word of ['yes', 'START', 'stop it', 'please stop', '', 'HELP']) {
      expect(isOptOutWord(word)).toBe(false);
    }
  });
});

describe('confirming a number with a one-time code', () => {
  it('texts the code in fixed words, without the assistant’s name, and keeps only a hash of it', async () => {
    const h = await textsHarness({ assistantName: 'Call +15550999 about your bank' });
    await expect(h.numbers.sendCode({ owner: ALICE, phone: PHONE })).resolves.toEqual({ ok: true });
    expect(h.sent).toEqual([
      {
        to: PHONE,
        body: 'Your confirmation code is 111111. It works for 10 minutes. If you did not ask for it, ignore this text.',
      },
    ]);
    const stored = await h.contacts.get(ALICE);
    expect(JSON.stringify(stored)).not.toContain('111111');
    expect(stored?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.confirmed_at).toBeNull();
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({ confirmed: false, code_pending: true });
  });

  it('keys the code with the server’s secret, and a code made with another secret is not pending', async () => {
    const h = await textsHarness({ codeKey: 'first-secret' });
    await h.numbers.sendCode({ owner: ALICE, phone: PHONE });
    const other = h.serviceWith({ codeKey: 'second-secret' });
    await expect(other.status(ALICE)).resolves.toMatchObject({ code_pending: false });
    await expect(other.confirm({ owner: ALICE, code: '111111' })).resolves.toEqual({ ok: false, reason: 'no_code' });
    await expect(h.contacts.get(ALICE)).resolves.toMatchObject({ code_attempts: 0 });
    await expect(h.numbers.confirm({ owner: ALICE, code: '111111' })).resolves.toEqual({ ok: true });
  });

  it('a STOP while a code is being checked is not undone by the check', async () => {
    const h = await textsHarness();
    await h.readyToText();
    await h.numbers.sendCode({ owner: ALICE, phone: PHONE });
    const count = h.contacts.countCodeAttempt.bind(h.contacts);
    jest.spyOn(h.contacts, 'countCodeAttempt').mockImplementation(async owner => {
      const attempts = await count(owner);
      await h.numbers.stopNumber(PHONE);
      return attempts;
    });
    await expect(h.numbers.confirm({ owner: ALICE, code: '111111' })).resolves.toEqual({
      ok: false,
      reason: 'no_code',
    });
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({ confirmed: false, opted_out: true });
  });

  it('confirms on the right code, once, and records it in Activity', async () => {
    const h = await textsHarness();
    await h.numbers.sendCode({ owner: ALICE, phone: PHONE });
    await expect(h.numbers.confirm({ owner: ALICE, code: ' 111111 ' })).resolves.toEqual({ ok: true });
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({ confirmed: true, code_pending: false });
    await expect(h.numbers.confirm({ owner: ALICE, code: '111111' })).resolves.toEqual({
      ok: false,
      reason: 'no_code',
    });
    expect(h.activity.map(row => row.tool_name)).toContain('delivery.sms_confirmed');
  });

  it('refuses a code after it has expired, and forgets it', async () => {
    const h = await textsHarness();
    await h.numbers.sendCode({ owner: ALICE, phone: PHONE });
    h.clock.now = new Date(h.clock.now.getTime() + CODE_TTL_MS + 1);
    await expect(h.numbers.confirm({ owner: ALICE, code: '111111' })).resolves.toEqual({
      ok: false,
      reason: 'expired',
    });
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({ confirmed: false, code_pending: false });
    await expect(h.numbers.confirm({ owner: ALICE, code: '111111' })).resolves.toEqual({
      ok: false,
      reason: 'no_code',
    });
  });

  it('accepts a code just inside its time', async () => {
    const h = await textsHarness();
    await h.numbers.sendCode({ owner: ALICE, phone: PHONE });
    h.clock.now = new Date(h.clock.now.getTime() + CODE_TTL_MS - 1000);
    await expect(h.numbers.confirm({ owner: ALICE, code: '111111' })).resolves.toEqual({ ok: true });
  });

  it('counts wrong tries, then voids the code even for the right one', async () => {
    const h = await textsHarness();
    await h.numbers.sendCode({ owner: ALICE, phone: PHONE });
    for (let tried = 1; tried < MAX_CODE_ATTEMPTS; tried += 1) {
      await expect(h.numbers.confirm({ owner: ALICE, code: '000000' })).resolves.toEqual({
        ok: false,
        reason: 'wrong',
        attempts_left: MAX_CODE_ATTEMPTS - tried,
      });
    }
    await expect(h.numbers.confirm({ owner: ALICE, code: '000000' })).resolves.toEqual({
      ok: false,
      reason: 'too_many',
    });
    await expect(h.numbers.confirm({ owner: ALICE, code: '111111' })).resolves.toEqual({
      ok: false,
      reason: 'no_code',
    });
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({ confirmed: false });
  });

  it('lets the right code through on the last allowed try', async () => {
    const h = await textsHarness();
    await h.numbers.sendCode({ owner: ALICE, phone: PHONE });
    for (let tried = 1; tried < MAX_CODE_ATTEMPTS; tried += 1) {
      await h.numbers.confirm({ owner: ALICE, code: '000000' });
    }
    await expect(h.numbers.confirm({ owner: ALICE, code: '111111' })).resolves.toEqual({ ok: true });
  });

  it('limits codes to a few an hour, whatever number is asked for, then frees up', async () => {
    const h = await textsHarness();
    for (let sent = 0; sent < MAX_CODES_PER_HOUR; sent += 1) {
      await expect(h.numbers.sendCode({ owner: ALICE, phone: `+1555011${String(sent)}` })).resolves.toEqual({
        ok: true,
      });
    }
    const refused = await h.numbers.sendCode({ owner: ALICE, phone: '+15550199' });
    expect(refused).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(h.sent).toHaveLength(MAX_CODES_PER_HOUR);
    h.clock.now = new Date(h.clock.now.getTime() + 61 * 60_000);
    await expect(h.numbers.sendCode({ owner: ALICE, phone: '+15550199' })).resolves.toEqual({ ok: true });
  });

  it('removing the number does not start the hour over', async () => {
    const h = await textsHarness();
    for (let sent = 0; sent < MAX_CODES_PER_HOUR; sent += 1) {
      await h.numbers.sendCode({ owner: ALICE, phone: PHONE });
    }
    await h.numbers.remove(ALICE);
    await expect(h.numbers.sendCode({ owner: ALICE, phone: PHONE })).resolves.toMatchObject({
      ok: false,
      reason: 'rate_limited',
    });
    expect(h.sent).toHaveLength(MAX_CODES_PER_HOUR);
  });

  it('codes asked for at the same moment cannot pass the hourly limit together', async () => {
    const h = await textsHarness();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) => h.numbers.sendCode({ owner: ALICE, phone: `+1555012${String(index)}` })),
    );
    expect(results.filter(result => result.ok)).toHaveLength(MAX_CODES_PER_HOUR);
    expect(h.sent).toHaveLength(MAX_CODES_PER_HOUR);
  });

  it('limits codes to one number however many people ask, by the hour and by the day', async () => {
    const h = await textsHarness();
    const person = (index: number) => ({ tenant_id: 'default', created_by: `person-${String(index)}` });
    for (let index = 0; index < MAX_CODES_PER_NUMBER_PER_HOUR; index += 1) {
      await expect(h.numbers.sendCode({ owner: person(index), phone: PHONE })).resolves.toEqual({ ok: true });
    }
    await expect(h.numbers.sendCode({ owner: person(99), phone: PHONE })).resolves.toMatchObject({
      ok: false,
      reason: 'rate_limited',
    });
    let asked = MAX_CODES_PER_NUMBER_PER_HOUR;
    let sent = MAX_CODES_PER_NUMBER_PER_HOUR;
    while (sent < MAX_CODES_PER_NUMBER_PER_DAY) {
      h.clock.now = new Date(h.clock.now.getTime() + 61 * 60_000);
      const result = await h.numbers.sendCode({ owner: person(asked), phone: PHONE });
      asked += 1;
      if (result.ok) {
        sent += 1;
      }
    }
    h.clock.now = new Date(h.clock.now.getTime() + 61 * 60_000);
    await expect(h.numbers.sendCode({ owner: person(asked), phone: PHONE })).resolves.toMatchObject({
      ok: false,
      reason: 'rate_limited',
    });
    expect(h.sent).toHaveLength(MAX_CODES_PER_NUMBER_PER_DAY);
    h.clock.now = new Date(h.clock.now.getTime() + 24 * 60 * 60_000);
    await expect(h.numbers.sendCode({ owner: person(asked + 1), phone: PHONE })).resolves.toEqual({ ok: true });
  });

  it('others filling a number’s limits do not lock out the person who confirmed it', async () => {
    const h = await textsHarness();
    await h.readyToText();
    const person = (index: number) => ({ tenant_id: 'default', created_by: `person-${String(index)}` });
    for (let index = 0; index < MAX_CODES_PER_NUMBER_PER_HOUR; index += 1) {
      await h.numbers.sendCode({ owner: person(index), phone: PHONE });
    }
    await expect(h.numbers.sendCode({ owner: person(99), phone: PHONE })).resolves.toMatchObject({
      reason: 'rate_limited',
    });
    await expect(h.numbers.sendCode({ owner: ALICE, phone: PHONE })).resolves.toEqual({ ok: true });
  });

  it('others filling a number’s limits do not lock out the person who confirmed it, after a STOP and START', async () => {
    const h = await textsHarness();
    await h.readyToText();
    await h.numbers.stopNumber(PHONE);
    const person = (index: number) => ({ tenant_id: 'default', created_by: `person-${String(index)}` });
    for (let index = 0; index < MAX_CODES_PER_NUMBER_PER_HOUR; index += 1) {
      await h.numbers.sendCode({ owner: person(index), phone: PHONE });
    }
    await expect(h.numbers.sendCode({ owner: person(99), phone: PHONE })).resolves.toMatchObject({
      reason: 'rate_limited',
    });
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({ confirmed: false, opted_out: true });
    await expect(h.numbers.sendCode({ owner: ALICE, phone: PHONE })).resolves.toEqual({ ok: true });
  });

  it('a number that replied STOP is not theirs for someone who never confirmed it', async () => {
    const h = await textsHarness();
    const mallory = { tenant_id: 'default', created_by: 'mallory' };
    await expect(h.numbers.sendCode({ owner: mallory, phone: PHONE })).resolves.toEqual({ ok: true });
    await h.numbers.stopNumber(PHONE);
    for (let index = 1; index < MAX_CODES_PER_NUMBER_PER_HOUR; index += 1) {
      await h.numbers.sendCode({
        owner: { tenant_id: 'default', created_by: `person-${String(index)}` },
        phone: PHONE,
      });
    }
    await expect(h.numbers.sendCode({ owner: mallory, phone: PHONE })).resolves.toMatchObject({
      ok: false,
      reason: 'rate_limited',
    });
    expect(h.sent).toHaveLength(MAX_CODES_PER_NUMBER_PER_HOUR);
  });

  it('limits codes for one person in a day, below the server’s cap', async () => {
    const h = await textsHarness();
    let sent = 0;
    for (let round = 0; sent < MAX_CODES_PER_PERSON_PER_DAY; round += 1) {
      const result = await h.numbers.sendCode({ owner: ALICE, phone: `+1555040${String(round).padStart(4, '0')}` });
      if (result.ok) {
        sent += 1;
      } else {
        h.clock.now = new Date(h.clock.now.getTime() + 61 * 60_000);
      }
    }
    h.clock.now = new Date(h.clock.now.getTime() + 61 * 60_000);
    await expect(h.numbers.sendCode({ owner: ALICE, phone: '+15550499999' })).resolves.toMatchObject({
      ok: false,
      reason: 'rate_limited',
    });
    expect(MAX_CODES_PER_PERSON_PER_DAY).toBeLessThan(MAX_CODES_PER_SERVER_PER_DAY);
  });

  it('a code another limit refuses spends none of the server’s day', async () => {
    const h = await textsHarness();
    const person = (index: number) => ({ tenant_id: 'default', created_by: `person-${String(index)}` });
    for (let index = 0; index < MAX_CODES_PER_NUMBER_PER_HOUR + 20; index += 1) {
      await h.numbers.sendCode({ owner: person(index), phone: PHONE });
    }
    expect(h.sent).toHaveLength(MAX_CODES_PER_NUMBER_PER_HOUR);
    for (let index = MAX_CODES_PER_NUMBER_PER_HOUR; index < MAX_CODES_PER_SERVER_PER_DAY; index += 1) {
      await expect(
        h.numbers.sendCode({ owner: person(100 + index), phone: `+1555050${String(index).padStart(4, '0')}` }),
      ).resolves.toEqual({ ok: true });
    }
  });

  it('the person who confirmed a number can get a new code to it when the server’s day is used up', async () => {
    const h = await textsHarness();
    await h.readyToText();
    for (let index = 0; index < MAX_CODES_PER_SERVER_PER_DAY; index += 1) {
      const owner = { tenant_id: 'default', created_by: `person-${String(index)}` };
      await h.numbers.sendCode({ owner, phone: `+1555060${String(index).padStart(4, '0')}` });
    }
    await expect(
      h.numbers.sendCode({ owner: { tenant_id: 'default', created_by: 'one-more' }, phone: '+15550699999' }),
    ).resolves.toMatchObject({ ok: false, reason: 'rate_limited' });
    await expect(h.numbers.sendCode({ owner: ALICE, phone: PHONE })).resolves.toEqual({ ok: true });
  });

  it('counts a number typed with its trunk zero as the same number', async () => {
    const pairs: [string, string][] = [
      ['+4407700900123', '+447700900123'],
      ['+9005321234567', '+905321234567'],
      ['+35308512345678', '+3538512345678'],
    ];
    for (const [typed, plain] of pairs) {
      const h = await textsHarness();
      const person = (index: number) => ({ tenant_id: 'default', created_by: `person-${String(index)}` });
      for (let index = 0; index < MAX_CODES_PER_NUMBER_PER_HOUR; index += 1) {
        await h.numbers.sendCode({ owner: person(index), phone: typed });
      }
      await expect([typed, await h.numbers.sendCode({ owner: person(99), phone: plain })]).toEqual([
        typed,
        expect.objectContaining({ reason: 'rate_limited' }),
      ]);
    }
  });

  it('keeps numbers apart whose country code holds a 0', async () => {
    const pairs: [string, string][] = [
      ['+302101234567', '+32101234567'],
      ['+905321234567', '+95321234567'],
      ['+5025551234', '+525551234'],
      ['+12025550100', '+1225550100'],
    ];
    for (const [number, other] of pairs) {
      const h = await textsHarness();
      const person = (index: number) => ({ tenant_id: 'default', created_by: `person-${String(index)}` });
      for (let index = 0; index < MAX_CODES_PER_NUMBER_PER_HOUR; index += 1) {
        await h.numbers.sendCode({ owner: person(index), phone: number });
      }
      await expect([number, await h.numbers.sendCode({ owner: person(99), phone: other })]).toEqual([
        number,
        { ok: true },
      ]);
    }
  });

  it('caps codes across the whole server in a day', async () => {
    const h = await textsHarness();
    for (let index = 0; index < MAX_CODES_PER_SERVER_PER_DAY; index += 1) {
      const owner = { tenant_id: 'default', created_by: `person-${String(index)}` };
      await expect(h.numbers.sendCode({ owner, phone: `+1555030${String(index).padStart(4, '0')}` })).resolves.toEqual({
        ok: true,
      });
    }
    await expect(
      h.numbers.sendCode({ owner: { tenant_id: 'default', created_by: 'one-more' }, phone: '+15550399999' }),
    ).resolves.toMatchObject({ ok: false, reason: 'rate_limited' });
  });

  it('a new code voids the old one', async () => {
    const h = await textsHarness();
    await h.numbers.sendCode({ owner: ALICE, phone: PHONE });
    await h.numbers.sendCode({ owner: ALICE, phone: PHONE });
    await expect(h.numbers.confirm({ owner: ALICE, code: '111111' })).resolves.toMatchObject({
      ok: false,
      reason: 'wrong',
    });
    await expect(h.numbers.confirm({ owner: ALICE, code: '222222' })).resolves.toEqual({ ok: true });
  });

  it('sends nothing but the code to a number that is not confirmed, and says why to a bad number', async () => {
    const h = await textsHarness();
    await expect(h.numbers.sendCode({ owner: ALICE, phone: 'not a number' })).resolves.toEqual({
      ok: false,
      reason: 'bad_number',
    });
    expect(h.sent).toHaveLength(0);
  });

  it('says texts are not set up when the server has no provider', async () => {
    const h = await textsHarness({ provider: false });
    await expect(h.numbers.sendCode({ owner: ALICE, phone: PHONE })).resolves.toEqual({
      ok: false,
      reason: 'not_set_up',
    });
  });

  it('forgets the code when it could not be sent', async () => {
    const h = await textsHarness();
    h.next.result = { outcome: 'failed', failure: 'invalid_number' };
    await expect(h.numbers.sendCode({ owner: ALICE, phone: PHONE })).resolves.toEqual({
      ok: false,
      reason: 'send_failed',
      failure: 'invalid_number',
    });
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({ code_pending: false });
  });

  it('says when the number replied STOP before, so the code could not go to it', async () => {
    const h = await textsHarness();
    h.next.result = { outcome: 'failed', failure: 'opted_out' };
    await expect(h.numbers.sendCode({ owner: ALICE, phone: PHONE })).resolves.toEqual({
      ok: false,
      reason: 'send_failed',
      failure: 'opted_out',
    });
  });

  it('a different number replaces one that was never confirmed', async () => {
    const h = await textsHarness();
    await h.numbers.sendCode({ owner: ALICE, phone: PHONE });
    await h.numbers.sendCode({ owner: ALICE, phone: '+15550122' });
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({
      phone: '+15550122',
      pending_phone: null,
      confirmed: false,
      code_pending: true,
    });
  });

  it('a new number waits beside the confirmed one until its code is confirmed', async () => {
    const h = await textsHarness();
    await h.readyToText();
    await h.numbers.sendCode({ owner: ALICE, phone: '+15550122' });
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({
      phone: PHONE,
      pending_phone: '+15550122',
      confirmed: true,
      code_pending: true,
    });
    expect((await h.reachSettings.get(ALICE))?.channels.texts).toBe(true);
    await expect(h.numbers.confirm({ owner: ALICE, code: '111111' })).resolves.toEqual({ ok: true });
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({
      phone: '+15550122',
      pending_phone: null,
      confirmed: true,
      code_pending: false,
    });
    expect((await h.reachSettings.get(ALICE))?.channels.texts).toBe(true);
  });

  it('keeps the confirmed number when the code to a new one could not be sent', async () => {
    const h = await textsHarness();
    await h.readyToText();
    h.next.result = { outcome: 'failed', failure: 'invalid_number' };
    await h.numbers.sendCode({ owner: ALICE, phone: '+15550122' });
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({
      phone: PHONE,
      pending_phone: null,
      confirmed: true,
      code_pending: false,
    });
    expect((await h.reachSettings.get(ALICE))?.channels.texts).toBe(true);
  });

  it('asking for a fresh code for the same number does not unconfirm it', async () => {
    const h = await textsHarness();
    await h.readyToText();
    await h.numbers.sendCode({ owner: ALICE, phone: PHONE });
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({ confirmed: true });
    expect((await h.reachSettings.get(ALICE))?.channels.texts).toBe(true);
  });

  it('keeps the choice of words, and refuses to set it before a number exists', async () => {
    const h = await textsHarness();
    await expect(h.numbers.setMode({ owner: ALICE, mode: 'full' })).resolves.toEqual({
      ok: false,
      reason: 'no_number',
    });
    await h.numbers.sendCode({ owner: ALICE, phone: PHONE });
    await h.numbers.setMode({ owner: ALICE, mode: 'full' });
    await h.numbers.confirm({ owner: ALICE, code: '111111' });
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({ mode: 'full', confirmed: true });
  });

  it('removing the number switches texts off and forgets it', async () => {
    const h = await textsHarness();
    await h.readyToText();
    await h.numbers.remove(ALICE);
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({ phone: null, confirmed: false });
    expect((await h.reachSettings.get(ALICE))?.channels.texts).toBe(false);
    expect(h.activity.map(row => row.tool_name)).toContain('delivery.sms_removed');
  });
});

describe('STOP', () => {
  it('turns texts off for the number, unconfirms it and records it in Activity', async () => {
    const h = await textsHarness();
    await h.readyToText();
    await expect(h.numbers.stopNumber(PHONE)).resolves.toBe(1);
    expect((await h.reachSettings.get(ALICE))?.channels.texts).toBe(false);
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({ confirmed: false, opted_out: true });
    const row = h.activity.find(entry => entry.tool_name === 'delivery.sms_stop');
    expect(row?.created_by).toBe('alice');
    expect(row?.description).toContain('STOP');
  });

  it('reaches everyone who has the number, and no one else', async () => {
    const h = await textsHarness();
    await h.readyToText();
    const bob = { tenant_id: 'default', created_by: 'bob' };
    const carol = { tenant_id: 'other', created_by: 'carol' };
    await h.readyToText({ owner: bob, phone: '+15550133' });
    await h.readyToText({ owner: carol });
    await expect(h.numbers.stopNumber(PHONE)).resolves.toBe(2);
    expect((await h.reachSettings.get(bob))?.channels.texts).toBe(true);
    await expect(h.numbers.status(bob)).resolves.toMatchObject({ confirmed: true, opted_out: false });
    expect((await h.reachSettings.get(carol))?.channels.texts).toBe(false);
    await expect(h.numbers.status(carol)).resolves.toMatchObject({ confirmed: false, opted_out: true });
  });

  it('a STOP from a new number drops it and keeps the confirmed one', async () => {
    const h = await textsHarness();
    await h.readyToText();
    await h.numbers.sendCode({ owner: ALICE, phone: '+15550122' });
    await expect(h.numbers.stopNumber('+15550122')).resolves.toBe(1);
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({
      phone: PHONE,
      pending_phone: null,
      confirmed: true,
      code_pending: false,
    });
    expect((await h.reachSettings.get(ALICE))?.channels.texts).toBe(true);
    await expect(h.numbers.confirm({ owner: ALICE, code: '111111' })).resolves.toEqual({
      ok: false,
      reason: 'no_code',
    });
    expect(h.activity.map(row => row.tool_name)).toEqual(['delivery.sms_new_number_stopped']);
  });

  it('a number nobody has changes nothing', async () => {
    const h = await textsHarness();
    await expect(h.numbers.stopNumber('+15550177')).resolves.toBe(0);
    expect(h.activity).toEqual([]);
  });

  it('needs a fresh code before texts can come back', async () => {
    const h = await textsHarness();
    await h.readyToText();
    await h.numbers.stopNumber(PHONE);
    await h.numbers.sendCode({ owner: ALICE, phone: PHONE });
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({ confirmed: false, opted_out: true });
    await h.numbers.confirm({ owner: ALICE, code: '111111' });
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({ confirmed: true, opted_out: false });
  });
});
