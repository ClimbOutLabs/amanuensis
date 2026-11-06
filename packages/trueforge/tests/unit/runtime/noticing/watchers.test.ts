import type { MailMessage, MailSource, MailWindowRead } from '../../../../src/runtime/noticing/sources';
import { MessageUnreadableError } from '../../../../src/runtime/noticing/sources';
import { MAX_STUCK_MS, MAX_STUCK_PASSES, readMailWindow, watchMail } from '../../../../src/runtime/noticing/watchers';
import { defaultReachSettings } from '../../../../src/schemas/reach';

const SINCE = new Date('2026-11-05T14:00:00.000Z');
const NOW = new Date('2026-11-05T15:00:00.000Z');

function message({ id, at, from = 'someone@example.com' }: { id: string; at: Date; from?: string }): MailMessage {
  return {
    id,
    thread_id: null,
    from_address: from,
    from_name: null,
    subject: 'Hello',
    snippet: '',
    received_at: at,
    authentication_results: [],
  };
}

/** A source that answers each window from `inbox`, saying `too_many` past `fits` messages. */
function sourceOf({
  inbox,
  fits,
  answer,
  trusted = ['mx.example.net'],
}: {
  inbox: MailMessage[];
  fits: number;
  trusted?: readonly string[];
  answer?: (input: { since: Date; before: Date; from: readonly string[] | undefined }) => MailWindowRead | undefined;
}): { source: MailSource; asked: { since: Date; before: Date; from: readonly string[] | undefined }[] } {
  const asked: { since: Date; before: Date; from: readonly string[] | undefined }[] = [];
  const source: MailSource = {
    listNewMessages: ({ since, before, from }) => {
      asked.push({ since, before, from });
      const given = answer?.({ since, before, from });
      if (given !== undefined) {
        return Promise.resolve(given);
      }
      const found = inbox.filter(
        item =>
          item.received_at >= since &&
          item.received_at < before &&
          (from === undefined || from.includes(item.from_address)),
      );
      return Promise.resolve(found.length > fits ? { read: 'too_many' } : { read: 'all', messages: found });
    },
    readText: () => Promise.resolve(''),
    laterInThread: () => Promise.resolve([]),
    trustedAuthenticationServers: trusted,
  };
  return { source, asked };
}

const logger = () => ({ warn: jest.fn() });

describe('readMailWindow', () => {
  it('reads the whole window when it fits, and leaves the next start to the caller', async () => {
    const inbox = [message({ id: 'a', at: new Date('2026-11-05T14:30:00.000Z') })];
    const { source } = sourceOf({ inbox, fits: 10 });
    await expect(
      readMailWindow({ source, since: SINCE, now: NOW, limit: 10, keep_from: [], logger: logger() }),
    ).resolves.toEqual({ messages: inbox, resume_from: undefined });
  });

  it('halves the window until the mail in it fits, and starts the next pass where it stopped', async () => {
    const inbox = Array.from({ length: 4 }, (_, n) =>
      message({ id: String(n), at: new Date(SINCE.getTime() + (n + 1) * 10 * 60_000) }),
    );
    const { source, asked } = sourceOf({ inbox, fits: 2 });
    const read = await readMailWindow({ source, since: SINCE, now: NOW, limit: 2, keep_from: [], logger: logger() });
    expect(read.messages.map(item => item.id)).toEqual(['0', '1']);
    expect(read.resume_from).toEqual(new Date('2026-11-05T14:30:00.000Z'));
    expect(asked.map(item => item.before)).toEqual([NOW, new Date('2026-11-05T14:30:00.000Z')]);
  });

  it('starts again at the same place when a slow read got nothing, and after the last message it got', async () => {
    const first = message({ id: 'a', at: new Date('2026-11-05T14:10:00.000Z') });
    const none = sourceOf({ inbox: [], fits: 10, answer: () => ({ read: 'oldest', messages: [] }) });
    await expect(
      readMailWindow({ source: none.source, since: SINCE, now: NOW, limit: 10, keep_from: [], logger: logger() }),
    ).resolves.toEqual({ messages: [], resume_from: SINCE });
    const some = sourceOf({ inbox: [], fits: 10, answer: () => ({ read: 'oldest', messages: [first] }) });
    await expect(
      readMailWindow({ source: some.source, since: SINCE, now: NOW, limit: 10, keep_from: [], logger: logger() }),
    ).resolves.toEqual({ messages: [first], resume_from: first.received_at });
  });

  it('passes over a flood within a few seconds, with a warning, and moves past it', async () => {
    const at = new Date(SINCE.getTime() + 1000);
    const inbox = Array.from({ length: 600 }, (_, n) => message({ id: String(n), at }));
    const { source } = sourceOf({ inbox, fits: 500 });
    const warnings = logger();
    const read = await readMailWindow({ source, since: SINCE, now: NOW, limit: 100, keep_from: [], logger: warnings });
    expect(read.messages).toEqual([]);
    expect(read.resume_from?.getTime()).toBeLessThanOrEqual(SINCE.getTime() + 4000);
    expect(read.resume_from?.getTime()).toBeGreaterThan(at.getTime());
    expect(warnings.warn).toHaveBeenCalledWith(
      'Passed over a flood of mail that arrived within a few seconds',
      expect.any(Object),
    );
  });

  it('still reads mail from always-important senders inside a flood', async () => {
    const at = new Date(SINCE.getTime() + 1000);
    const boss = message({ id: 'boss', at, from: 'boss@example.com' });
    const inbox = [...Array.from({ length: 600 }, (_, n) => message({ id: String(n), at })), boss];
    const { source, asked } = sourceOf({ inbox, fits: 500 });
    const read = await readMailWindow({
      source,
      since: SINCE,
      now: NOW,
      limit: 100,
      keep_from: ['boss@example.com'],
      logger: logger(),
    });
    expect(read.messages).toEqual([boss]);
    expect(asked.at(-1)?.from).toEqual(['boss@example.com']);
  });

  it('does not look for always-important senders in a flood when the source cannot vouch for them', async () => {
    const at = new Date(SINCE.getTime() + 1000);
    const forged = message({ id: 'forged', at, from: 'boss@example.com' });
    const inbox = [...Array.from({ length: 600 }, (_, n) => message({ id: String(n), at })), forged];
    const { source, asked } = sourceOf({ inbox, fits: 500, trusted: [] });
    const read = await readMailWindow({
      source,
      since: SINCE,
      now: NOW,
      limit: 100,
      keep_from: ['boss@example.com'],
      logger: logger(),
    });
    expect(read.messages).toEqual([]);
    expect(asked.some(item => item.from !== undefined)).toBe(false);
  });
});

describe('watchMail when a message cannot be read', () => {
  const bill = (id: string, minute: number): MailMessage => ({
    ...message({ id, at: new Date(SINCE.getTime() + minute * 60_000) }),
    subject: `Invoice ${id}: amount due by November 7`,
  });
  const settings = defaultReachSettings('UTC');

  /** A source whose `readText` fails for the ids in `failing`, and says what it read. */
  function failingSource({ inbox, failing }: { inbox: MailMessage[]; failing: Record<string, () => Error> }) {
    const read: string[] = [];
    const source: MailSource = {
      listNewMessages: () => Promise.resolve({ read: 'all', messages: inbox }),
      readText: item => {
        read.push(item.id);
        const fail = failing[item.id];
        return fail === undefined ? Promise.resolve('Amount due by November 7') : Promise.reject(fail());
      },
      laterInThread: () => Promise.resolve([]),
      trustedAuthenticationServers: [],
    };
    return { source, read };
  }
  const watch = (input: { source: MailSource; stuck?: { message_id: string; passes: number; since: Date } }) =>
    watchMail({ source: input.source, settings, since: SINCE, now: NOW, logger: logger(), stuck: input.stuck });

  it('keeps what messages before the failing one found, and starts the next pass at the failing one', async () => {
    const inbox = [bill('a', 1), bill('b', 2), bill('c', 3)];
    const rateLimited = new Error('Too many requests.');
    const { source } = failingSource({ inbox, failing: { b: () => rateLimited } });
    const found = await watch({ source });
    expect(found.raise.concat(found.track).map(event => event.id)).toEqual(['bill_due:a']);
    expect(found.resume_from).toEqual(inbox[1]?.received_at);
    expect(found.stopped_by).toEqual({ error: rateLimited });
    expect(found.stuck).toEqual({ message_id: 'b', passes: 1, since: NOW });
  });

  it('counts one more pass against the same message, and keeps when it first failed', async () => {
    const inbox = [bill('a', 1), bill('b', 2)];
    const { source } = failingSource({ inbox, failing: { b: () => new Error('busy') } });
    const earlier = new Date(NOW.getTime() - 20 * 60_000);
    const found = await watch({ source, stuck: { message_id: 'b', passes: 1, since: earlier } });
    expect(found.stuck).toEqual({ message_id: 'b', passes: 2, since: earlier });
    expect(found.stopped_by).toBeDefined();
  });

  it('starts counting again when a different message fails', async () => {
    const inbox = [bill('a', 1)];
    const { source } = failingSource({ inbox, failing: { a: () => new Error('busy') } });
    const found = await watch({ source, stuck: { message_id: 'z', passes: 2, since: new Date(0) } });
    expect(found.stuck).toEqual({ message_id: 'a', passes: 1, since: NOW });
  });

  it(`passes a message over after ${String(MAX_STUCK_PASSES)} failed passes, with a warning, and reads the rest`, async () => {
    const inbox = [bill('a', 1), bill('b', 2), bill('c', 3)];
    const { source, read } = failingSource({ inbox, failing: { b: () => new Error('busy') } });
    const warnings = logger();
    const found = await watchMail({
      source,
      settings,
      since: SINCE,
      now: NOW,
      logger: warnings,
      stuck: { message_id: 'b', passes: MAX_STUCK_PASSES - 1, since: new Date(NOW.getTime() - 60_000) },
    });
    expect(read).toEqual(['a', 'b', 'c']);
    expect(found.raise.concat(found.track).map(event => event.id)).toEqual(['bill_due:a', 'bill_due:c']);
    expect(found.stopped_by).toBeUndefined();
    expect(found.stuck).toBeUndefined();
    expect(warnings.warn).toHaveBeenCalledWith(
      'Passed over a mail the mail server kept failing on',
      expect.objectContaining({ message_id: 'b' }),
    );
  });

  it('passes a message over once it has failed for about an hour, however few passes that took', async () => {
    const inbox = [bill('a', 1)];
    const { source } = failingSource({ inbox, failing: { a: () => new Error('busy') } });
    const found = await watch({
      source,
      stuck: { message_id: 'a', passes: 1, since: new Date(NOW.getTime() - MAX_STUCK_MS) },
    });
    expect(found.stopped_by).toBeUndefined();
    expect(found.stuck).toBeUndefined();
  });

  it('passes over a message that can never be read at once, and clears the count', async () => {
    const inbox = [bill('a', 1), bill('b', 2)];
    const { source } = failingSource({
      inbox,
      failing: { a: () => new MessageUnreadableError({ cause: new Error('gone') }) },
    });
    const found = await watch({ source, stuck: { message_id: 'a', passes: 2, since: SINCE } });
    expect(found.raise.concat(found.track).map(event => event.id)).toEqual(['bill_due:b']);
    expect(found.stuck).toBeUndefined();
    expect(found.stopped_by).toBeUndefined();
  });
});
