import type { MailMessage, MailSource, MailWindowRead } from '../../../../src/runtime/noticing/sources';
import { readMailWindow } from '../../../../src/runtime/noticing/watchers';

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
}: {
  inbox: MailMessage[];
  fits: number;
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
    trustedAuthenticationServers: [],
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

  it('halves a window that is too slow to list, and fails the pass when even a few seconds are', async () => {
    const inbox = [message({ id: 'a', at: new Date('2026-11-05T14:10:00.000Z') })];
    const halfHour = new Date('2026-11-05T14:30:00.000Z');
    const slowOverHalfHour = sourceOf({
      inbox,
      fits: 10,
      answer: ({ before }) => (before.getTime() > halfHour.getTime() ? { read: 'too_slow' } : undefined),
    });
    await expect(
      readMailWindow({
        source: slowOverHalfHour.source,
        since: SINCE,
        now: NOW,
        limit: 10,
        keep_from: [],
        logger: logger(),
      }),
    ).resolves.toEqual({ messages: inbox, resume_from: halfHour });
    const neverAnswers = sourceOf({ inbox, fits: 10, answer: () => ({ read: 'too_slow' }) });
    await expect(
      readMailWindow({
        source: neverAnswers.source,
        since: SINCE,
        now: NOW,
        limit: 10,
        keep_from: [],
        logger: logger(),
      }),
    ).rejects.toThrow('did not list a few seconds of mail in time');
  });
});
