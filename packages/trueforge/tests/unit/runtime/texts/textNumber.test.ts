import {
  CODE_TTL_MS,
  isOptOutWord,
  MAX_CODE_ATTEMPTS,
  MAX_CODES_PER_HOUR,
  normalizePhoneNumber,
} from '../../../../src/runtime/texts/textNumber';
import { defaultReachSettings } from '../../../../src/schemas/reach';
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
  it('texts the code in the assistant’s name and keeps only a hash of it', async () => {
    const h = await textsHarness({ assistantName: 'Mannie' });
    await expect(h.numbers.sendCode({ owner: ALICE, phone: PHONE })).resolves.toEqual({ ok: true });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.to).toBe(PHONE);
    expect(h.sent[0]?.body).toContain('Mannie: your confirmation code is 111111');
    const stored = await h.contacts.get(ALICE);
    expect(JSON.stringify(stored)).not.toContain('111111');
    expect(stored?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.confirmed_at).toBeNull();
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({ confirmed: false, code_pending: true });
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
    });
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({ code_pending: false });
  });

  it('a different number starts unconfirmed and switches texts off', async () => {
    const h = await textsHarness();
    await h.readyToText();
    await h.numbers.sendCode({ owner: ALICE, phone: '+15550122' });
    await expect(h.numbers.status(ALICE)).resolves.toMatchObject({ phone: '+15550122', confirmed: false });
    expect((await h.reachSettings.get(ALICE))?.channels.texts).toBe(false);
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
    const ownContact = await h.contacts.get(ALICE);
    if (ownContact === undefined) {
      throw new Error('The contact was not saved.');
    }
    await h.contacts.put({ ...bob, contact: { ...ownContact, phone: '+15550133' } });
    await h.reachSettings.put({
      ...bob,
      settings: { ...defaultReachSettings('UTC'), channels: { texts: true, calls: false } },
    });
    await h.numbers.stopNumber(PHONE);
    expect((await h.reachSettings.get(bob))?.channels.texts).toBe(true);
    await expect(h.numbers.status(bob)).resolves.toMatchObject({ confirmed: true, opted_out: false });
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
