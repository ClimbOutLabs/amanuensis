import { GoogleApiError } from '@truefoundry/trueforge-core/core/google/errors';

import type { StuckMessage } from '../../../../src/db/noticingStore';
import type { MailMessage, MailWindowRead, TimedMailSource } from '../../../../src/runtime/noticing/sources';
import { MailSourceBusyError, MessageUnreadableError } from '../../../../src/runtime/noticing/sources';
import {
  MAX_STUCK_PASSES,
  readMailWindow,
  SHORTEST_WINDOW_MS,
  watchMail,
} from '../../../../src/runtime/noticing/watchers';
import { defaultReachSettings } from '../../../../src/schemas/reach';
import { readMessages } from './mailWindowSupport';

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
}): { source: TimedMailSource; asked: { since: Date; before: Date; from: readonly string[] | undefined }[] } {
  const asked: { since: Date; before: Date; from: readonly string[] | undefined }[] = [];
  const source: TimedMailSource = {
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
    reportsSenderConfirmation: trusted.length > 0,
  };
  return { source, asked };
}

const logger = () => ({ warn: jest.fn() });

describe('readMailWindow', () => {
  it('reads the whole window when it fits, and leaves the next start to the caller', async () => {
    const inbox = [message({ id: 'a', at: new Date('2026-11-05T14:30:00.000Z') })];
    const { source } = sourceOf({ inbox, fits: 10 });
    await expect(
      readMailWindow({
        source,
        since: SINCE,
        now: NOW,
        limit: 10,
        keep_from: [],
        logger: logger(),
        out_of_time: () => false,
      }),
    ).resolves.toMatchObject({ messages: inbox, resume_from: undefined });
  });

  it('halves the window until the mail in it fits, and starts the next pass where it stopped', async () => {
    const inbox = Array.from({ length: 4 }, (_, n) =>
      message({ id: String(n), at: new Date(SINCE.getTime() + (n + 1) * 10 * 60_000) }),
    );
    const { source, asked } = sourceOf({ inbox, fits: 2 });
    const read = await readMailWindow({
      source,
      since: SINCE,
      now: NOW,
      limit: 2,
      keep_from: [],
      logger: logger(),
      out_of_time: () => false,
    });
    expect(readMessages(read).map(item => item.id)).toEqual(['0', '1']);
    expect(read.resume_from).toEqual(new Date('2026-11-05T14:30:00.000Z'));
    expect(asked.map(item => item.before)).toEqual([NOW, new Date('2026-11-05T14:30:00.000Z')]);
  });

  it('starts again at the same place when a slow read got nothing, and after the last message it got', async () => {
    const first = message({ id: 'a', at: new Date('2026-11-05T14:10:00.000Z') });
    const none = sourceOf({ inbox: [], fits: 10, answer: () => ({ read: 'oldest', messages: [] }) });
    await expect(
      readMailWindow({
        source: none.source,
        since: SINCE,
        now: NOW,
        limit: 10,
        keep_from: [],
        logger: logger(),
        out_of_time: () => false,
      }),
    ).resolves.toMatchObject({ messages: [], resume_from: SINCE });
    const some = sourceOf({ inbox: [], fits: 10, answer: () => ({ read: 'oldest', messages: [first] }) });
    await expect(
      readMailWindow({
        source: some.source,
        since: SINCE,
        now: NOW,
        limit: 10,
        keep_from: [],
        logger: logger(),
        out_of_time: () => false,
      }),
    ).resolves.toMatchObject({ messages: [first], resume_from: first.received_at });
  });

  it('passes over a flood within a few seconds, with a warning, and moves past it', async () => {
    const at = new Date(SINCE.getTime() + 1000);
    const inbox = Array.from({ length: 600 }, (_, n) => message({ id: String(n), at }));
    const { source } = sourceOf({ inbox, fits: 500 });
    const warnings = logger();
    const read = await readMailWindow({
      source,
      since: SINCE,
      now: NOW,
      limit: 100,
      keep_from: [],
      logger: warnings,
      out_of_time: () => false,
    });
    expect(readMessages(read)).toEqual([]);
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
      out_of_time: () => false,
    });
    expect(readMessages(read)).toEqual([boss]);
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
      out_of_time: () => false,
    });
    expect(readMessages(read)).toEqual([]);
    expect(asked.some(item => item.from !== undefined)).toBe(false);
  });
});

describe('readMailWindow when the rest of the window runs out of time', () => {
  it('keeps the mail listed before a failing stretch, and starts the next pass after it', async () => {
    const bad = new Date('2026-11-05T14:30:00.000Z');
    const early = message({ id: 'early', at: new Date('2026-11-05T14:05:00.000Z') });
    const inbox = [early, message({ id: 'late', at: new Date('2026-11-05T14:50:00.000Z') })];
    let cellRead = false;
    const source: TimedMailSource = {
      listNewMessages: ({ since, before }) => {
        const covers = since.getTime() <= bad.getTime() && before.getTime() > bad.getTime();
        if (covers && before.getTime() - since.getTime() > SHORTEST_WINDOW_MS) {
          return Promise.reject(new Error('cannot list'));
        }
        if (covers && before.getTime() - since.getTime() <= SHORTEST_WINDOW_MS) {
          // The few seconds are read last, and the rest of the window then has no time left.
          cellRead = true;
        }
        const found = inbox.filter(item => item.received_at >= since && item.received_at < before);
        return Promise.resolve({ read: 'all', messages: found });
      },
      readText: () => Promise.resolve(''),
      laterInThread: () => Promise.resolve([]),
      trustedAuthenticationServers: [],
      reportsSenderConfirmation: false,
    };
    const read = await readMailWindow({
      source,
      since: SINCE,
      now: NOW,
      limit: 10,
      keep_from: [],
      logger: logger(),
      out_of_time: () => cellRead,
    });
    expect(read.status).toBe('read');
    expect(read.status === 'read' ? readMessages(read).map(item => item.id) : []).toContain('early');
    expect((read.resume_from ?? NOW).getTime()).toBeLessThanOrEqual(new Date('2026-11-05T14:50:00.000Z').getTime());
  });
});

describe('readMailWindow when the rest of the window fails after the stretch that failed alone', () => {
  it('keeps the mail read before and in that stretch, and starts the next pass after it', async () => {
    const bad = new Date('2026-11-05T14:30:01.000Z');
    const early = message({ id: 'early', at: new Date('2026-11-05T14:05:00.000Z') });
    const inside = message({ id: 'inside', at: bad });
    const late = message({ id: 'late', at: new Date('2026-11-05T14:50:00.000Z') });
    const failedOnce = new Set<number>();
    const source: TimedMailSource = {
      listNewMessages: ({ since, before }) => {
        const covers = since.getTime() <= bad.getTime() && before.getTime() > bad.getTime();
        const wide = before.getTime() - since.getTime() > SHORTEST_WINDOW_MS;
        // The bad stretch fails once on its own and then reads, and everything after it fails, as when the server
        // goes away.
        const firstAlone = covers && !wide && !failedOnce.has(since.getTime());
        if (firstAlone) {
          failedOnce.add(since.getTime());
        }
        if ((covers && wide) || firstAlone || since.getTime() > bad.getTime()) {
          return Promise.reject(new Error('cannot list'));
        }
        const found = [early, inside, late].filter(item => item.received_at >= since && item.received_at < before);
        return Promise.resolve({ read: 'all', messages: found });
      },
      readText: () => Promise.resolve(''),
      laterInThread: () => Promise.resolve([]),
      trustedAuthenticationServers: [],
      reportsSenderConfirmation: false,
    };
    const read = await readMailWindow({
      source,
      since: SINCE,
      now: NOW,
      limit: 10,
      keep_from: [],
      logger: logger(),
      out_of_time: () => false,
    });
    expect(read.status).toBe('read');
    expect(read.status === 'read' ? readMessages(read).map(item => item.id) : []).toEqual(['early', 'inside']);
    expect(read.resume_from?.getTime()).toBeGreaterThan(bad.getTime());
    expect(read.resume_from?.getTime()).toBeLessThanOrEqual(late.received_at.getTime());
  });
});

describe('watchMail when a message cannot be read', () => {
  const bill = (id: string, minute: number): MailMessage => ({
    ...message({ id, at: new Date(SINCE.getTime() + minute * 60_000) }),
    subject: `Invoice ${id}: amount due by November 7`,
  });
  const settings = defaultReachSettings('UTC');
  const outage = () => new MailSourceBusyError({ cause: new Error('Too many requests.') });

  /** A source whose `readText` fails for the ids in `failing`, and says what it read. */
  function failingSource({ inbox, failing }: { inbox: MailMessage[]; failing: Record<string, () => Error> }) {
    const read: string[] = [];
    const source: TimedMailSource = {
      listNewMessages: () => Promise.resolve({ read: 'all', messages: inbox }),
      readText: item => {
        read.push(item.id);
        const fail = failing[item.id];
        return fail === undefined ? Promise.resolve('Amount due by November 7') : Promise.reject(fail());
      },
      laterInThread: () => Promise.resolve([]),
      trustedAuthenticationServers: [],
      reportsSenderConfirmation: false,
    };
    return { source, read };
  }
  const watch = (input: {
    source: TimedMailSource;
    stuck?: StuckMessage | undefined;
    out_of_time?: () => boolean;
    log?: ReturnType<typeof logger>;
  }) =>
    watchMail({
      source: input.source,
      settings,
      since: SINCE,
      now: NOW,
      logger: input.log ?? logger(),
      stuck: input.stuck,
      out_of_time: input.out_of_time ?? (() => false),
      assistant: 'Mira',
    });
  const ids = (found: { raise: { id: string }[]; track: { id: string }[] }) =>
    found.raise.concat(found.track).map(event => event.id);

  it('keeps what messages before the failing one found, and starts the next pass at the failing one', async () => {
    const inbox = [bill('a', 1), bill('b', 2), bill('c', 3)];
    const failure = new Error('Gmail did not accept that request.');
    const { source } = failingSource({ inbox, failing: { b: () => failure } });
    const found = await watch({ source });
    expect(ids(found)).toEqual(['bill_due:a', 'bill_due:c']);
    expect(found.resume_from).toEqual(inbox[1]?.received_at);
    expect(found.stopped_by).toEqual({ error: failure });
    expect(found.stuck).toEqual({ message_id: 'b', passes: 1, since: NOW });
  });

  it('counts one more pass against the same message', async () => {
    const { source } = failingSource({
      inbox: [bill('a', 1), bill('b', 2), bill('c', 3)],
      failing: { b: () => new Error('x') },
    });
    const found = await watch({ source, stuck: { message_id: 'b', passes: 1, since: SINCE } });
    expect(found.stuck).toEqual({ message_id: 'b', passes: 2, since: SINCE });
    expect(found.stopped_by).toBeDefined();
  });

  it('starts counting again when a different message fails', async () => {
    const { source } = failingSource({
      inbox: [bill('a', 1), bill('b', 2)],
      failing: { a: () => new Error('x') },
    });
    const found = await watch({ source, stuck: { message_id: 'z', passes: 2, since: SINCE } });
    expect(found.stuck).toEqual({ message_id: 'a', passes: 1, since: NOW });
  });

  it(`passes a message over after ${String(MAX_STUCK_PASSES)} failed passes, with a warning, and reads the rest`, async () => {
    const inbox = [bill('a', 1), bill('b', 2), bill('c', 3)];
    const { source, read } = failingSource({ inbox, failing: { b: () => new Error('x') } });
    const warnings = logger();
    const found = await watchMail({
      source,
      settings,
      since: SINCE,
      now: NOW,
      logger: warnings,
      stuck: { message_id: 'b', passes: MAX_STUCK_PASSES - 1, since: SINCE },
      out_of_time: () => false,
      assistant: 'Mira',
    });
    // b is tried again once c has read, and fails again.
    expect(read).toEqual(['a', 'b', 'c', 'b']);
    // The message that looked like a bill and could not be read becomes a fixed note.
    expect(ids(found)).toEqual(['bill_due:a', 'bill_due:c', 'bill_due:b']);
    expect(found.stopped_by).toBeUndefined();
    expect(found.stuck).toBeUndefined();
    expect(warnings.warn).toHaveBeenCalledWith(
      'Passed over a mail the mail server kept failing on',
      expect.objectContaining({ message_id: 'b' }),
    );
  });

  it('counts the next failing message from one once another was passed over, so one bad message never passes over the rest', async () => {
    const inbox = [bill('a', 1), bill('b', 2), bill('c', 3), bill('d', 4), bill('e', 5)];
    const { source } = failingSource({
      inbox,
      failing: { b: () => new Error('x'), d: () => new Error('x') },
    });
    const found = await watch({ source, stuck: { message_id: 'b', passes: MAX_STUCK_PASSES - 1, since: SINCE } });
    expect(ids(found)).toEqual(['bill_due:a', 'bill_due:c', 'bill_due:b', 'bill_due:e']);
    expect(found.stuck).toEqual({ message_id: 'd', passes: 1, since: NOW });
    expect(found.stopped_by).toBeDefined();
  });

  describe('when the server or the connection is down', () => {
    it('never counts a busy failure, so no pass-over comes of a long outage', async () => {
      const inbox = [bill('a', 1), bill('b', 2)];
      const { source } = failingSource({ inbox, failing: { a: outage, b: outage } });
      let stuck: StuckMessage | undefined;
      for (let pass = 0; pass < MAX_STUCK_PASSES + 2; pass += 1) {
        const found = await watch({ source, stuck });
        expect(found.stopped_by).toBeDefined();
        expect(found.resume_from).toEqual(inbox[0]?.received_at);
        stuck = found.stuck;
      }
      // Which message it stopped at is kept, but never counted.
      expect(stuck).toEqual({ message_id: 'a', passes: 0, since: NOW });
    });

    it('never counts a busy failure even when other reads in the pass worked', async () => {
      const { source } = failingSource({ inbox: [bill('a', 1), bill('b', 2), bill('c', 3)], failing: { b: outage } });
      const found = await watch({ source });
      expect(found.stuck).toEqual({ message_id: 'b', passes: 0, since: NOW });
      expect(found.stopped_by).toBeDefined();
      expect(found.resume_from).toEqual(new Date(SINCE.getTime() + 2 * 60_000));
    });

    it('starts counting from nothing for a message other than the one counted before', async () => {
      const { source } = failingSource({ inbox: [bill('a', 1), bill('z', 2)], failing: { a: outage } });
      const earlier = { message_id: 'z', passes: 2, since: SINCE };
      expect((await watch({ source, stuck: earlier })).stuck).toEqual({ message_id: 'a', passes: 0, since: NOW });
    });

    it('passes nothing over in a long outage whose failures look like plain errors', async () => {
      // A dropped connection can come back as an ordinary failure for each message, with no read working at all.
      const inbox = [bill('a', 1), bill('b', 2), bill('c', 3)];
      const { source } = failingSource({
        inbox,
        failing: { a: () => new Error('x'), b: () => new Error('x'), c: () => new Error('x') },
      });
      let stuck: StuckMessage | undefined;
      for (let pass = 0; pass < MAX_STUCK_PASSES + 1; pass += 1) {
        const found = await watch({ source, stuck });
        expect(found.stopped_by).toBeDefined();
        expect(found.resume_from).toEqual(inbox[0]?.received_at);
        stuck = found.stuck;
      }
      expect(stuck).toEqual({ message_id: 'a', passes: 0, since: NOW });
    });

    it('passes nothing over when every read is refused', async () => {
      const refused = () => new GoogleApiError({ status: 403, message: 'Gmail refused the request.' });
      const inbox = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, n) => bill(id, n + 1));
      const { source, read } = failingSource({
        inbox,
        failing: Object.fromEntries(inbox.map(item => [item.id, refused])),
      });
      const found = await watch({ source });
      expect(read).toEqual(['a', 'b']);
      expect(found.stopped_by).toBeDefined();
      expect(found.stuck).toEqual({ message_id: 'a', passes: 0, since: NOW });
      expect(found.resume_from).toEqual(inbox[0]?.received_at);
    });

    it('does not count a failure that no later read confirmed, and stops the pass on a busy one after it', async () => {
      // b failed plainly in two earlier passes. Then c and d fail as busy: nothing says b is the problem.
      const inbox = [bill('a', 1), bill('b', 2), bill('c', 3), bill('d', 4)];
      const { source } = failingSource({
        inbox,
        failing: { b: () => new Error('x'), c: outage, d: outage },
      });
      const found = await watch({ source, stuck: { message_id: 'b', passes: 2, since: SINCE } });
      expect(ids(found)).toEqual(['bill_due:a']);
      expect(found.stopped_by?.error).toBeInstanceOf(MailSourceBusyError);
      expect(found.stuck).toEqual({ message_id: 'b', passes: 2, since: SINCE });
      expect(found.resume_from).toEqual(inbox[1]?.received_at);
    });

    it('stops on a busy failure after a message was passed over, and does not pass over more', async () => {
      const inbox = [bill('a', 1), bill('b', 2), bill('c', 3), bill('d', 4)];
      const { source } = failingSource({ inbox, failing: { b: () => new Error('x'), c: outage, d: outage } });
      // b is passed over only when a later read confirms it, which a busy c never does.
      const found = await watch({ source, stuck: { message_id: 'b', passes: MAX_STUCK_PASSES - 1, since: SINCE } });
      expect(found.stopped_by).toBeDefined();
      expect(found.resume_from).toEqual(inbox[1]?.received_at);
    });

    it('does not carry the count of a message just passed over when the pass then stops on a busy failure', async () => {
      const inbox = [bill('a', 1), bill('b', 2), bill('c', 3), bill('d', 4)];
      const { source } = failingSource({ inbox, failing: { b: () => new Error('x'), d: outage } });
      const found = await watch({ source, stuck: { message_id: 'b', passes: MAX_STUCK_PASSES - 1, since: SINCE } });
      expect(ids(found)).toEqual(['bill_due:a', 'bill_due:c', 'bill_due:b']);
      expect(found.stuck).toEqual({ message_id: 'd', passes: 0, since: NOW });
      expect(found.stopped_by).toBeDefined();
      expect(found.resume_from).toEqual(inbox[3]?.received_at);
    });

    it('counts a plain failure once a later message was read, since the server answered', async () => {
      const inbox = [bill('a', 1), bill('b', 2), bill('c', 3)];
      const { source } = failingSource({ inbox, failing: { b: () => new Error('x') } });
      const found = await watch({ source });
      expect(found.stuck).toEqual({ message_id: 'b', passes: 1, since: NOW });
    });
  });

  it('stops without counting or failing when the pass is out of time, and resumes at the message it did not reach', async () => {
    const inbox = [bill('a', 1), bill('b', 2), bill('c', 3)];
    const { source, read } = failingSource({ inbox, failing: {} });
    let looks = 0;
    const found = await watch({
      source,
      stuck: { message_id: 'c', passes: 2, since: SINCE },
      out_of_time: () => (looks += 1) > 3,
    });
    expect(read).toEqual(['a']);
    expect(found.stopped_by).toBeUndefined();
    expect(found.resume_from).toEqual(inbox[1]?.received_at);
    expect(found.stuck).toEqual({ message_id: 'c', passes: 2, since: SINCE });
  });

  describe("when a bill's thread cannot be checked", () => {
    const threadFailing = (failure: () => Error): { source: TimedMailSource } => {
      const { source } = failingSource({ inbox: [bill('a', 1), bill('b', 2)], failing: {} });
      return { source: { ...source, laterInThread: () => Promise.reject(failure()) } };
    };
    it.each([
      ['a plain failure', () => new Error('The Email connector could not fetch the message.')],
      ['an unreadable reply', () => new MessageUnreadableError({ cause: new Error('too large') })],
      ['a busy server', outage],
    ])('tracks the bill and does not stop the pass for %s', async (_name, failure) => {
      const { source } = threadFailing(failure);
      const found = await watch({ source });
      expect(found.track.map(event => event.id)).toEqual(['bill_due:a', 'bill_due:b']);
      expect(found.raise).toEqual([]);
      expect(found.stopped_by).toBeUndefined();
      expect(found.stuck).toBeUndefined();
    });
  });

  it("starts the next pass at the failing message's arrival", async () => {
    const inbox = [bill('a', 1), bill('b', 2), bill('c', 3)];
    const arrival = failingSource({ inbox, failing: { b: () => new Error('x') } });
    expect((await watch({ source: arrival.source })).resume_from).toEqual(inbox[1]?.received_at);
  });

  it('passes over a message that can never be read at once, and clears the count', async () => {
    const inbox = [bill('a', 1), bill('b', 2)];
    const { source } = failingSource({
      inbox,
      failing: { a: () => new MessageUnreadableError({ cause: new Error('gone') }) },
    });
    const found = await watch({ source, stuck: { message_id: 'a', passes: 2, since: SINCE } });
    // The message that can never be read is told about, since it looked like a bill.
    expect(ids(found)).toEqual(['bill_due:a', 'bill_due:b']);
    expect(found.stuck).toBeUndefined();
    expect(found.stopped_by).toBeUndefined();
  });
});

describe('watchMail when a list fails', () => {
  const settings = defaultReachSettings('UTC');
  const at = (minute: number) => new Date(SINCE.getTime() + minute * 60_000);
  const bill = (id: string, minute: number): MailMessage => ({
    ...message({ id, at: at(minute) }),
    subject: `Invoice ${id}: amount due by November 7`,
  });
  // One message the connector cannot list: every window that holds it fails.
  const bad = at(20);
  const inbox = [bill('a', 10), bill('c', 40)];
  const sourceWith = (failure: () => Error): { source: TimedMailSource; windows: number[] } => {
    const windows: number[] = [];
    const source: TimedMailSource = {
      listNewMessages: ({ since, before }) => {
        windows.push(before.getTime() - since.getTime());
        if (since <= bad && bad < before) {
          return Promise.reject(failure());
        }
        const found = inbox.filter(item => item.received_at >= since && item.received_at < before);
        return Promise.resolve({ read: 'all', messages: found });
      },
      readText: () => Promise.resolve('Amount due by November 7'),
      laterInThread: () => Promise.resolve([]),
      trustedAuthenticationServers: [],
      reportsSenderConfirmation: false,
    };
    return { source, windows };
  };
  const pass = ({ source, since, stuck }: { source: TimedMailSource; since: Date; stuck?: StuckMessage | undefined }) =>
    watchMail({
      source,
      settings,
      since,
      now: NOW,
      logger: logger(),
      stuck,
      out_of_time: () => false,
      assistant: 'Mira',
    });

  it('halves the window to find the slice that fails, and passes it over after a few passes, with a warning', async () => {
    const { source } = sourceWith(() => new Error('The Email connector returned an incomplete metadata page.'));
    const warnings = logger();
    const seen: string[] = [];
    const gaps: { from: Date; to: Date }[] = [];
    let since = SINCE;
    let stuck: StuckMessage | undefined;
    let passes = 0;
    for (; passes < 80; passes += 1) {
      const found = await watchMail({
        source,
        settings,
        since,
        now: NOW,
        logger: warnings,
        stuck,
        out_of_time: () => false,
        assistant: 'Mira',
      });
      seen.push(...found.raise.map(event => event.id));
      gaps.push(...found.gaps);
      stuck = found.stuck;
      if (found.resume_from === undefined) {
        break;
      }
      since = found.resume_from;
    }
    expect(passes).toBeLessThan(80);
    // The stretch passed over is told about once, in a fixed note.
    expect(seen).toEqual(['bill_due:a', 'bill_due:c']);
    expect(gaps).toEqual([{ from: new Date('2026-11-05T14:20:00.000Z'), to: new Date('2026-11-05T14:20:04.000Z') }]);
    expect(warnings.warn).toHaveBeenCalledWith(
      'Passed over mail that the mail server could not list',
      expect.objectContaining({ passes: MAX_STUCK_PASSES, since: '2026-11-05T14:20:00.000Z' }),
    );
  });

  it('stops the pass and counts the failing slice until it is passed over', async () => {
    const { source } = sourceWith(() => new Error('The Email connector returned an incomplete metadata page.'));
    const first = await pass({ source, since: SINCE });
    expect(first.stopped_by).toBeDefined();
    expect(first.stuck?.passes).toBe(1);
    // The next pass starts at the few seconds that fail, and the count carries over.
    expect(bad.getTime() - (first.resume_from?.getTime() ?? 0)).toBeLessThanOrEqual(4000);
    const again = await pass({ source, since: first.resume_from ?? SINCE, stuck: first.stuck });
    expect(again.stuck?.passes).toBe(2);
  });

  it('does not halve for a busy server, which says nothing about the mail', async () => {
    const { source, windows } = sourceWith(() => new MailSourceBusyError({ cause: new Error('slow') }));
    await expect(pass({ source, since: SINCE })).rejects.toBeInstanceOf(MailSourceBusyError);
    expect(windows).toHaveLength(1);
  });

  it('never halves past the time the pass has', async () => {
    const { source, windows } = sourceWith(
      () => new Error('The Email connector returned an incomplete metadata page.'),
    );
    const found = await watchMail({
      source,
      settings,
      since: SINCE,
      now: NOW,
      logger: logger(),
      stuck: undefined,
      out_of_time: () => windows.length >= 2,
      assistant: 'Mira',
    });
    expect(windows).toHaveLength(2);
    expect(found.stopped_by).toBeUndefined();
    // The short list at the start worked, so the pass keeps that progress.
    expect(found.resume_from).toEqual(new Date(SINCE.getTime() + 4000));
  });
});

describe('watchMail keeps trouble and progress on every way of stopping', () => {
  const settings = defaultReachSettings('UTC');
  const at = (minute: number) => new Date(SINCE.getTime() + minute * 60_000);
  const bill = (id: string, minute: number): MailMessage => ({
    ...message({ id, at: at(minute) }),
    subject: `Invoice ${id}: amount due by November 7`,
  });
  const base = { settings, now: NOW, logger: logger(), assistant: 'Mira' };
  const sourceOf = ({
    inbox,
    readText,
  }: {
    inbox: MailMessage[];
    readText?: (item: MailMessage) => Promise<string>;
  }): { source: TimedMailSource; windows: { since: Date; before: Date }[] } => {
    const windows: { since: Date; before: Date }[] = [];
    return {
      windows,
      source: {
        listNewMessages: ({ since, before }) => {
          windows.push({ since, before });
          const found = inbox.filter(item => item.received_at >= since && item.received_at < before);
          return Promise.resolve({ read: 'all', messages: found });
        },
        readText: readText ?? (() => Promise.resolve('Amount due by November 7')),
        laterInThread: () => Promise.resolve([]),
        trustedAuthenticationServers: [],
        reportsSenderConfirmation: false,
      },
    };
  };

  it('shows it fell behind when a pass runs out of time before it read a single message', async () => {
    const { source } = sourceOf({ inbox: [bill('a', 1)] });
    let looks = 0;
    const found = await watchMail({
      ...base,
      source,
      since: at(1),
      stuck: undefined,
      out_of_time: () => (looks += 1) > 1,
    });
    expect(found.timed_out).toBe(true);
    expect(found.stopped_by).toBeUndefined();
    expect(found.resume_from).toEqual(at(1));
  });

  it('checks the time before each call to the mail server, not only between messages', async () => {
    let calls = 0;
    const { source } = sourceOf({
      inbox: [bill('a', 1), bill('b', 2)],
      readText: () => {
        calls += 1;
        return Promise.resolve('Amount due by November 7');
      },
    });
    let expired = false;
    const found = await watchMail({
      ...base,
      source,
      since: SINCE,
      stuck: undefined,
      // The time runs out right after the first read, before the thread check.
      out_of_time: () => {
        const was = expired;
        expired = calls >= 1;
        return was;
      },
    });
    expect(calls).toBe(1);
    expect(found.raise.concat(found.track).map(event => event.id)).toEqual(['bill_due:a']);
    expect(found.resume_from).toEqual(at(2));
  });
});

describe('watchMail when a list fails', () => {
  const settings = defaultReachSettings('UTC');
  const failure = () => new Error('The Email connector returned an incomplete metadata page.');
  const base = {
    settings,
    now: NOW,
    since: SINCE,
    logger: logger(),
    stuck: undefined,
    out_of_time: () => false,
    assistant: 'Mira',
  };

  it('stops and counts nothing when no list worked, whatever the window', async () => {
    const windows: number[] = [];
    const source: TimedMailSource = {
      listNewMessages: ({ since, before }) => {
        windows.push(before.getTime() - since.getTime());
        return Promise.reject(failure());
      },
      readText: () => Promise.resolve(''),
      laterInThread: () => Promise.resolve([]),
      trustedAuthenticationServers: [],
      reportsSenderConfirmation: false,
    };
    let stuck: StuckMessage | undefined;
    for (let pass = 0; pass < 6; pass += 1) {
      windows.length = 0;
      const found = await watchMail({ ...base, source, stuck });
      expect(found.stopped_by).toBeDefined();
      expect(found.resume_from).toEqual(SINCE);
      expect(found.stuck).toBeUndefined();
      expect(windows.length).toBeLessThanOrEqual(3);
      stuck = found.stuck;
    }
  });

  it('keeps looking inside one pass, and passes over only the few seconds that fail', async () => {
    const bad = new Date(SINCE.getTime() + 20 * 60_000 + 1500);
    const good = (id: string, minute: number): MailMessage => ({
      ...message({ id, at: new Date(SINCE.getTime() + minute * 60_000) }),
      subject: `Invoice ${id}: amount due by November 7`,
    });
    const inbox = [good('before', 10), good('after', 40)];
    const source: TimedMailSource = {
      listNewMessages: ({ since, before }) =>
        since <= bad && bad < before
          ? Promise.reject(failure())
          : Promise.resolve({
              read: 'all',
              messages: inbox.filter(item => item.received_at >= since && item.received_at < before),
            }),
      readText: () => Promise.resolve('Amount due by November 7'),
      laterInThread: () => Promise.resolve([]),
      trustedAuthenticationServers: [],
      reportsSenderConfirmation: false,
    };
    const first = await watchMail({ ...base, source });
    // The mail before the failing seconds was read in the same pass, and the pass says where it got stuck.
    expect(first.raise.map(event => event.id)).toEqual(['bill_due:before']);
    expect(first.stopped_by).toBeDefined();
    expect(first.stuck?.passes).toBe(1);
    expect(first.resume_from?.getTime()).toBeLessThanOrEqual(bad.getTime());
    expect(bad.getTime() - (first.resume_from?.getTime() ?? 0)).toBeLessThanOrEqual(4000);
    let since = first.resume_from ?? SINCE;
    let stuck = first.stuck;
    const warnings = logger();
    let last = first;
    const raised: string[] = [];
    for (let pass = 0; pass < 3; pass += 1) {
      last = await watchMail({ ...base, source, since, stuck, logger: warnings });
      raised.push(...last.raise.map(event => event.id), ...last.gaps.map(() => 'mail_gap:'));
      since = last.resume_from ?? since;
      stuck = last.stuck;
    }
    expect(raised.filter(id => id.startsWith('mail_gap:'))).toHaveLength(1);
    expect(warnings.warn).toHaveBeenCalledWith(
      'Passed over mail that the mail server could not list',
      expect.objectContaining({ passes: MAX_STUCK_PASSES }),
    );
    expect(last.raise.map(event => event.id)).toEqual(['bill_due:after']);
    expect(last.resume_from).toBeUndefined();
  });

  it('names a stretch that cannot be listed by where it is, so the count carries over from pass to pass', async () => {
    const bad = new Date(SINCE.getTime() + 20 * 60_000 + 1500);
    const source: TimedMailSource = {
      listNewMessages: ({ since, before }) =>
        since <= bad && bad < before ? Promise.reject(failure()) : Promise.resolve({ read: 'all', messages: [] }),
      readText: () => Promise.resolve(''),
      laterInThread: () => Promise.resolve([]),
      trustedAuthenticationServers: [],
      reportsSenderConfirmation: false,
    };
    const first = await watchMail({ ...base, source, now: NOW });
    const later = await watchMail({
      ...base,
      source,
      now: new Date(NOW.getTime() + 7 * 60_000),
      since: first.resume_from ?? SINCE,
      stuck: first.stuck,
    });
    expect(first.stuck?.message_id).toBe(later.stuck?.message_id);
    expect(later.stuck?.passes).toBe(2);
  });
});

describe('watchMail when a message keeps failing', () => {
  const settings = {
    ...defaultReachSettings('UTC'),
    always_important: [
      { address: 'boss@example.com', source: 'settings' as const, added_at: '2026-11-01T00:00:00.000Z' },
    ],
  };
  const at = (minute: number) => new Date(SINCE.getTime() + minute * 60_000);
  const bill = (id: string, minute: number): MailMessage => ({
    ...message({ id, at: at(minute) }),
    subject: `Invoice ${id}: amount due by November 7`,
  });
  const busy = () => new MailSourceBusyError({ cause: new Error('timed out') });
  const sourceWith = ({
    inbox,
    failing,
  }: {
    inbox: MailMessage[];
    failing: Record<string, (attempt: number) => Error | undefined>;
  }): { source: TimedMailSource; reads: string[] } => {
    const attempts = new Map<string, number>();
    const reads: string[] = [];
    return {
      reads,
      source: {
        listNewMessages: () => Promise.resolve({ read: 'all', messages: inbox }),
        readText: item => {
          reads.push(item.id);
          const attempt = (attempts.get(item.id) ?? 0) + 1;
          attempts.set(item.id, attempt);
          const error = failing[item.id]?.(attempt);
          return error === undefined ? Promise.resolve('Amount due by November 7') : Promise.reject(error);
        },
        laterInThread: () => Promise.resolve([]),
        trustedAuthenticationServers: [],
        reportsSenderConfirmation: false,
      },
    };
  };
  const run = (input: {
    source: TimedMailSource;
    stuck?: StuckMessage | undefined;
    now?: Date;
    log?: ReturnType<typeof logger>;
  }) =>
    watchMail({
      source: input.source,
      settings,
      since: SINCE,
      now: input.now ?? NOW,
      logger: input.log ?? logger(),
      stuck: input.stuck,
      out_of_time: () => false,
      assistant: 'Mira',
    });

  it('does not count a failure that a retry after a good read gets past', async () => {
    const { source, reads } = sourceWith({
      inbox: [bill('a', 1), bill('b', 2), bill('c', 3)],
      failing: { b: attempt => (attempt === 1 ? new Error('x') : undefined) },
    });
    const found = await run({ source });
    expect(reads).toEqual(['a', 'b', 'c', 'b']);
    expect(found.raise.map(event => event.id)).toEqual(['bill_due:a', 'bill_due:c', 'bill_due:b']);
    expect(found.stuck).toBeUndefined();
    expect(found.stopped_by).toBeUndefined();
  });

  it('does not confirm a failure with plain mail that needed no read', async () => {
    const plain = message({ id: 'plain', at: at(3) });
    const { source } = sourceWith({ inbox: [bill('a', 1), bill('b', 2), plain], failing: { b: () => new Error('x') } });
    const found = await run({ source, stuck: { message_id: 'b', passes: 2, since: SINCE } });
    expect(found.stuck).toEqual({ message_id: 'b', passes: 2, since: SINCE });
    expect(found.stopped_by).toBeDefined();
  });

  it('remembers which message a busy server stopped at, without counting it', async () => {
    const { source } = sourceWith({ inbox: [bill('a', 1), bill('b', 2), bill('c', 3)], failing: { b: busy } });
    const first = await run({ source });
    expect(first.stuck).toEqual({ message_id: 'b', passes: 0, since: NOW });
    expect(first.stopped_by?.error).toBeInstanceOf(MailSourceBusyError);
    const again = await run({ source, stuck: first.stuck });
    expect(again.stuck).toEqual({ message_id: 'b', passes: 0, since: NOW });
  });

  it('passes the message over and raises a fixed note once it has held up passes for hours and the rest reads', async () => {
    const { source } = sourceWith({ inbox: [bill('a', 1), bill('b', 2), bill('c', 3)], failing: { b: busy } });
    const warnings = logger();
    const found = await run({
      source,
      stuck: { message_id: 'b', passes: 0, since: new Date(NOW.getTime() - 4 * 3_600_000) },
      log: warnings,
    });
    expect(found.raise.map(event => event.id)).toEqual(['bill_due:a', 'bill_due:c', 'bill_due:b']);
    const note = found.raise.find(event => event.id === 'bill_due:b');
    expect(note?.summary).toBe(
      `A message from someone@example.com that arrived Thu, Nov 5, 2:02 PM could not be read, and it may matter. Open your mail to check it.`,
    );
    expect(note?.due_at).toBeNull();
    expect(found.stuck).toBeUndefined();
    expect(found.stopped_by).toBeUndefined();
    expect(warnings.warn).toHaveBeenCalledWith(
      'Passed over a mail the mail server kept failing on',
      expect.objectContaining({ message_id: 'b' }),
    );
  });

  it('does not pass a message over for a busy server before it has held up passes for hours', async () => {
    const { source } = sourceWith({ inbox: [bill('a', 1), bill('b', 2), bill('c', 3)], failing: { b: busy } });
    const found = await run({
      source,
      stuck: { message_id: 'b', passes: 0, since: new Date(NOW.getTime() - 2 * 3_600_000) },
    });
    expect(found.stuck).toEqual({ message_id: 'b', passes: 0, since: new Date(NOW.getTime() - 2 * 3_600_000) });
    expect(found.stopped_by).toBeDefined();
  });

  it('raises the note for a message from an always-important sender, and none for ordinary mail', async () => {
    const boss = {
      ...message({ id: 'boss', at: at(2), from: 'boss@example.com' }),
      subject: 'Hi',
      authentication_results: ['mx.example.net; dkim=pass header.d=example.com; dmarc=pass header.from=example.com'],
    };
    const plain = message({ id: 'plain', at: at(2) });
    for (const [item, expected] of [
      [boss, ['mail_always:boss']],
      [plain, []],
    ] as const) {
      const { source } = sourceWith({ inbox: [bill('a', 1), item, bill('c', 3)], failing: { [item.id]: busy } });
      const read: TimedMailSource = {
        ...source,
        trustedAuthenticationServers: ['mx.example.net'],
        reportsSenderConfirmation: true,
      };
      const found = await run({
        source: {
          ...read,
          readText: message =>
            message.id === item.id ? Promise.reject(busy()) : Promise.resolve('Amount due by November 7'),
        },
        stuck: { message_id: item.id, passes: 0, since: new Date(NOW.getTime() - 4 * 3_600_000) },
      });
      expect(found.raise.map(event => event.id).filter(id => !id.startsWith('bill_due'))).toEqual(expected);
    }
  });
});

describe('watchMail when a message has held up passes for hours', () => {
  const settings = defaultReachSettings('UTC');
  const at = (minute: number) => new Date(SINCE.getTime() + minute * 60_000);
  const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
  const bill = (id: string, minute: number): MailMessage => ({
    ...message({ id, at: at(minute) }),
    subject: `Invoice ${id}: amount due by November 7`,
  });
  const failing = (ids: Record<string, () => Error>, inbox: MailMessage[]) => {
    const read: string[] = [];
    const source: TimedMailSource = {
      listNewMessages: () => Promise.resolve({ read: 'all', messages: inbox }),
      readText: item => {
        read.push(item.id);
        const fail = ids[item.id];
        return fail === undefined ? Promise.resolve('Amount due by November 7') : Promise.reject(fail());
      },
      laterInThread: () => Promise.resolve([]),
      trustedAuthenticationServers: [],
      reportsSenderConfirmation: false,
    };
    return { source, read };
  };
  const run = ({ source, stuck, log }: { source: TimedMailSource; stuck?: StuckMessage; log?: { warn: jest.Mock } }) =>
    watchMail({
      source,
      settings,
      since: SINCE,
      now: NOW,
      logger: log ?? logger(),
      stuck,
      out_of_time: () => false,
      assistant: 'Mira',
    });
  const plain = () => new Error('The Email connector could not fetch the message.');
  const busy = () => new MailSourceBusyError({ cause: new Error('timed out') });

  it('passes nothing over and skips nothing when every read has failed for hours', async () => {
    const inbox = [bill('a', 1), bill('b', 2), bill('c', 3)];
    for (const fail of [plain, busy]) {
      const { source } = failing({ a: fail, b: fail, c: fail }, inbox);
      const found = await run({ source, stuck: { message_id: 'a', passes: 0, since: hoursAgo(5) } });
      expect(found.raise).toEqual([]);
      expect(found.resume_from).toEqual(inbox[0]?.received_at);
      expect(found.stuck).toMatchObject({ message_id: 'a', since: hoursAgo(5) });
      expect(found.stopped_by).toBeDefined();
    }
  });

  it('passes the stuck message over when other reads work, and keeps every message after the one that stops the pass', async () => {
    const inbox = [bill('a', 1), bill('b', 2), bill('c', 3), bill('d', 4)];
    const { source, read } = failing({ a: plain, c: plain, d: plain }, inbox);
    const found = await run({ source, stuck: { message_id: 'a', passes: 0, since: hoursAgo(5) } });
    // a failed again after b read, so it is passed over with a note. c and d then fail: the pass stops at c.
    expect(found.raise.map(event => event.id)).toEqual(['bill_due:b', 'bill_due:a']);
    expect(found.resume_from).toEqual(inbox[2]?.received_at);
    expect(found.stuck).toMatchObject({ message_id: 'c', passes: 0 });
    expect(found.stopped_by).toBeDefined();
    expect(read).not.toContain('never');
  });

  it('times the pass-over from when the message first stuck, not from when the trouble began', async () => {
    const inbox = [bill('a', 1), bill('b', 2), bill('c', 3)];
    const { source } = failing({ a: busy }, inbox);
    const found = await run({ source, stuck: { message_id: 'a', passes: 0, since: hoursAgo(1) } });
    expect(found.raise.map(event => event.id)).toEqual(['bill_due:b', 'bill_due:c']);
    expect(found.stuck).toMatchObject({ message_id: 'a', since: hoursAgo(1) });
  });

  it('logs only fixed words for a busy failure, never what it was caused by', async () => {
    const inbox = [bill('a', 1), bill('b', 2)];
    const cause = () =>
      new MailSourceBusyError({ cause: new Error('connect ECONNREFUSED http://mail-sidecar.internal:9000') });
    const { source } = failing({ a: cause }, inbox);
    const log = logger();
    await run({ source, stuck: { message_id: 'a', passes: 0, since: hoursAgo(5) }, log });
    expect(log.warn).toHaveBeenCalledWith(
      'Passed over a mail the mail server kept failing on',
      expect.objectContaining({ error: 'The mail server could not be reached or was too busy.' }),
    );
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('mail-sidecar.internal');
  });

  it('names the assistant it was given in a note, with when and from whom', async () => {
    const inbox = [bill('a', 1), bill('b', 2)];
    const { source } = failing({ a: plain }, inbox);
    const found = await run({ source, stuck: { message_id: 'a', passes: 0, since: hoursAgo(5) } });
    const note = found.raise.find(event => event.id === 'bill_due:a');
    expect(note?.facts).toContain('Mira could not read one message from someone@example.com');
    expect(note?.matched).toContain('Mira could not read this message');
    expect(note?.summary).toContain('someone@example.com');
  });
});

describe('watchMail with a flood and a bad header', () => {
  const settings = defaultReachSettings('UTC');
  const start = new Date('2026-11-05T14:20:00.000Z');
  const second = (n: number) => new Date(start.getTime() + n * 1000);

  /** A connector that fails a window with the bad header unless it is within one page, which holds the flood first. */
  const connector = ({ flood, bad, bill }: { flood: Date; bad: Date; bill: MailMessage }) => {
    const lists: { since: Date; before: Date }[] = [];
    const source: TimedMailSource = {
      listNewMessages: ({ since, before, from }) => {
        lists.push({ since, before });
        const holdsBad = since <= bad && bad < before;
        const holdsFlood = since <= flood && flood < before;
        if (from !== undefined) {
          return Promise.resolve({ read: 'all', messages: [] });
        }
        if (holdsBad && before.getTime() - since.getTime() > 4000) {
          return Promise.reject(new Error('incomplete metadata page'));
        }
        if (holdsFlood) {
          return Promise.resolve({ read: 'too_many' });
        }
        return Promise.resolve({
          read: 'all',
          messages: [bill].filter(item => item.received_at >= since && item.received_at < before),
        });
      },
      readText: () => Promise.resolve('Amount due by November 7'),
      laterInThread: () => Promise.resolve([]),
      trustedAuthenticationServers: [],
      reportsSenderConfirmation: false,
    };
    return { source, lists };
  };
  const bill = (at: Date): MailMessage => ({
    ...message({ id: 'bill', at }),
    subject: 'Invoice: amount due by November 7',
  });
  const watch = (source: TimedMailSource, now: Date) =>
    watchMail({
      source,
      settings,
      since: start,
      now,
      logger: logger(),
      stuck: undefined,
      out_of_time: () => false,
      assistant: 'Mira',
    });

  it('passes a flood in the last cell over with a note, instead of halving for ever', async () => {
    const { source } = connector({ flood: second(5), bad: second(6), bill: bill(second(1)) });
    const found = await watch(source, second(8));
    expect(found.timed_out).toBe(false);
    expect(found.stopped_by).toBeUndefined();
    expect(found.resume_from).toBeUndefined();
    expect(found.gaps).toHaveLength(1);
    expect(found.raise.map(event => event.id)).toEqual(['bill_due:bill']);
  });

  it('passes a flood over and goes on to the mail after it, in a few calls', async () => {
    const { source, lists } = connector({
      flood: second(5),
      bad: second(6),
      bill: bill(new Date(second(0).getTime() + 3_600_000 - 1000)),
    });
    const found = await watch(source, new Date(second(0).getTime() + 3_600_000));
    expect(found.timed_out).toBe(false);
    expect(found.resume_from).toBeUndefined();
    expect(found.gaps).toHaveLength(1);
    expect(found.raise.map(event => event.id)).toEqual(['bill_due:bill']);
    expect(lists.length).toBeLessThan(30);
  });
});

describe('watchMail window and thread checks', () => {
  const settings = defaultReachSettings('UTC');
  const bill = (id: string, due: string): MailMessage => ({
    ...message({ id, at: new Date(SINCE.getTime() + 60_000) }),
    subject: `Invoice ${id}: amount due by ${due}`,
  });

  it('does not check the thread of a bill that is due long after the window', async () => {
    const later = jest.fn(() => Promise.resolve<string[]>([]));
    const source: TimedMailSource = {
      listNewMessages: () => Promise.resolve({ read: 'all', messages: [bill('far', 'December 20')] }),
      readText: () => Promise.resolve('Amount due by December 20'),
      laterInThread: later,
      trustedAuthenticationServers: [],
      reportsSenderConfirmation: false,
    };
    const found = await watchMail({
      source,
      settings,
      since: SINCE,
      now: NOW,
      logger: logger(),
      stuck: undefined,
      out_of_time: () => false,
      assistant: 'Mira',
    });
    expect(found.track.map(event => event.id)).toEqual(['bill_due:far']);
    expect(later).not.toHaveBeenCalled();
  });
});
