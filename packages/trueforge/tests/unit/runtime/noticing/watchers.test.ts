import { GoogleApiError } from '@truefoundry/trueforge-core/core/google/errors';

import type { StuckMessage } from '../../../../src/db/noticingStore';
import type { MailMessage, MailSource, MailWindowRead } from '../../../../src/runtime/noticing/sources';
import { MailSourceBusyError, MessageUnreadableError } from '../../../../src/runtime/noticing/sources';
import { MAX_STUCK_PASSES, readMailWindow, watchMail } from '../../../../src/runtime/noticing/watchers';
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
    datesAreArrival: true,
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
    ).resolves.toEqual({ messages: inbox, resume_from: undefined });
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
    expect(read.messages.map(item => item.id)).toEqual(['0', '1']);
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
    ).resolves.toEqual({ messages: [], resume_from: SINCE });
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
    ).resolves.toEqual({ messages: [first], resume_from: first.received_at });
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
      out_of_time: () => false,
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
      out_of_time: () => false,
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
  const outage = () => new MailSourceBusyError({ cause: new Error('Too many requests.') });

  /** A source whose `readText` fails for the ids in `failing`, and says what it read. */
  function failingSource({
    inbox,
    failing,
    datesAreArrival = true,
  }: {
    inbox: MailMessage[];
    failing: Record<string, () => Error>;
    datesAreArrival?: boolean;
  }) {
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
      datesAreArrival,
    };
    return { source, read };
  }
  const watch = (input: { source: MailSource; stuck?: StuckMessage | undefined; out_of_time?: () => boolean }) =>
    watchMail({
      source: input.source,
      settings,
      since: SINCE,
      now: NOW,
      logger: logger(),
      stuck: input.stuck,
      out_of_time: input.out_of_time ?? (() => false),
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
    expect(found.stuck).toEqual({ message_id: 'b', passes: 1 });
  });

  it('counts one more pass against the same message', async () => {
    const { source } = failingSource({
      inbox: [bill('a', 1), bill('b', 2), bill('c', 3)],
      failing: { b: () => new Error('x') },
    });
    const found = await watch({ source, stuck: { message_id: 'b', passes: 1 } });
    expect(found.stuck).toEqual({ message_id: 'b', passes: 2 });
    expect(found.stopped_by).toBeDefined();
  });

  it('starts counting again when a different message fails', async () => {
    const { source } = failingSource({
      inbox: [bill('a', 1), bill('b', 2)],
      failing: { a: () => new Error('x') },
    });
    const found = await watch({ source, stuck: { message_id: 'z', passes: 2 } });
    expect(found.stuck).toEqual({ message_id: 'a', passes: 1 });
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
      stuck: { message_id: 'b', passes: MAX_STUCK_PASSES - 1 },
      out_of_time: () => false,
    });
    expect(read).toEqual(['a', 'b', 'c']);
    expect(ids(found)).toEqual(['bill_due:a', 'bill_due:c']);
    expect(found.stopped_by).toBeUndefined();
    expect(found.stuck).toBeUndefined();
    expect(warnings.warn).toHaveBeenCalledWith(
      'Passed over a mail the mail server kept failing on',
      expect.objectContaining({ message_id: 'b' }),
    );
  });

  it('passes over the next failing message after a single pass once one was passed over', async () => {
    const inbox = [bill('a', 1), bill('b', 2), bill('c', 3), bill('d', 4), bill('e', 5)];
    const { source } = failingSource({
      inbox,
      failing: { b: () => new Error('x'), d: () => new Error('x') },
    });
    const found = await watch({ source, stuck: { message_id: 'b', passes: MAX_STUCK_PASSES - 1 } });
    expect(ids(found)).toEqual(['bill_due:a', 'bill_due:c', 'bill_due:e']);
    expect(found.stopped_by).toBeUndefined();
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
      expect(stuck).toBeUndefined();
    });

    it('never counts a busy failure even when other reads in the pass worked', async () => {
      const { source } = failingSource({ inbox: [bill('a', 1), bill('b', 2), bill('c', 3)], failing: { b: outage } });
      const found = await watch({ source });
      expect(found.stuck).toBeUndefined();
      expect(found.stopped_by).toBeDefined();
      expect(found.resume_from).toEqual(new Date(SINCE.getTime() + 2 * 60_000));
    });

    it('leaves the count of another message as it was', async () => {
      const { source } = failingSource({ inbox: [bill('a', 1), bill('z', 2)], failing: { a: outage } });
      const earlier = { message_id: 'z', passes: 2 };
      expect((await watch({ source, stuck: earlier })).stuck).toEqual(earlier);
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
      expect(stuck).toBeUndefined();
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
      expect(found.stuck).toBeUndefined();
      expect(found.resume_from).toEqual(inbox[0]?.received_at);
    });

    it('does not count a failure that no later read confirmed, and stops the pass on a busy one after it', async () => {
      // b failed plainly in two earlier passes. Then c and d fail as busy: nothing says b is the problem.
      const inbox = [bill('a', 1), bill('b', 2), bill('c', 3), bill('d', 4)];
      const { source } = failingSource({
        inbox,
        failing: { b: () => new Error('x'), c: outage, d: outage },
      });
      const found = await watch({ source, stuck: { message_id: 'b', passes: 2 } });
      expect(ids(found)).toEqual(['bill_due:a']);
      expect(found.stopped_by?.error).toBeInstanceOf(MailSourceBusyError);
      expect(found.stuck).toEqual({ message_id: 'b', passes: 2 });
      expect(found.resume_from).toEqual(inbox[1]?.received_at);
    });

    it('stops on a busy failure after a message was passed over, and does not pass over more', async () => {
      const inbox = [bill('a', 1), bill('b', 2), bill('c', 3), bill('d', 4)];
      const { source } = failingSource({ inbox, failing: { b: () => new Error('x'), c: outage, d: outage } });
      // b is passed over only when a later read confirms it, which a busy c never does.
      const found = await watch({ source, stuck: { message_id: 'b', passes: MAX_STUCK_PASSES - 1 } });
      expect(found.stopped_by).toBeDefined();
      expect(found.resume_from).toEqual(inbox[1]?.received_at);
    });

    it('does not carry the count of a message just passed over when the pass then stops on a busy failure', async () => {
      const inbox = [bill('a', 1), bill('b', 2), bill('c', 3), bill('d', 4)];
      const { source } = failingSource({ inbox, failing: { b: () => new Error('x'), d: outage } });
      const found = await watch({ source, stuck: { message_id: 'b', passes: MAX_STUCK_PASSES - 1 } });
      expect(ids(found)).toEqual(['bill_due:a', 'bill_due:c']);
      expect(found.stuck).toBeUndefined();
      expect(found.stopped_by).toBeDefined();
      expect(found.resume_from).toEqual(inbox[3]?.received_at);
    });

    it('counts a plain failure once a later message was read, since the server answered', async () => {
      const inbox = [bill('a', 1), bill('b', 2), bill('c', 3)];
      const { source } = failingSource({ inbox, failing: { b: () => new Error('x') } });
      const found = await watch({ source });
      expect(found.stuck).toEqual({ message_id: 'b', passes: 1 });
    });
  });

  it('stops without counting or failing when the pass is out of time, and resumes at the message it did not reach', async () => {
    const inbox = [bill('a', 1), bill('b', 2), bill('c', 3)];
    const { source, read } = failingSource({ inbox, failing: {} });
    let looks = 0;
    const found = await watch({ source, stuck: { message_id: 'c', passes: 2 }, out_of_time: () => (looks += 1) > 2 });
    expect(read).toEqual(['a']);
    expect(found.stopped_by).toBeUndefined();
    expect(found.resume_from).toEqual(inbox[1]?.received_at);
    expect(found.stuck).toEqual({ message_id: 'c', passes: 2 });
  });

  describe("when a bill's thread cannot be checked", () => {
    const threadFailing = (failure: () => Error): { source: MailSource } => {
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

  it("starts the next pass at the failing message's arrival, or at the start where dates are written by the sender", async () => {
    const inbox = [bill('a', 1), bill('b', 2), bill('c', 3)];
    const arrival = failingSource({ inbox, failing: { b: () => new Error('x') } });
    expect((await watch({ source: arrival.source })).resume_from).toEqual(inbox[1]?.received_at);
    const written = failingSource({ inbox, failing: { b: () => new Error('x') }, datesAreArrival: false });
    expect((await watch({ source: written.source })).resume_from).toEqual(SINCE);
  });

  it('passes over a message that can never be read at once, and clears the count', async () => {
    const inbox = [bill('a', 1), bill('b', 2)];
    const { source } = failingSource({
      inbox,
      failing: { a: () => new MessageUnreadableError({ cause: new Error('gone') }) },
    });
    const found = await watch({ source, stuck: { message_id: 'a', passes: 2 } });
    expect(ids(found)).toEqual(['bill_due:b']);
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
  const sourceWith = (failure: () => Error): { source: MailSource; windows: number[] } => {
    const windows: number[] = [];
    const source: MailSource = {
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
      datesAreArrival: false,
    };
    return { source, windows };
  };
  const pass = ({ source, since, stuck }: { source: MailSource; since: Date; stuck?: StuckMessage | undefined }) =>
    watchMail({ source, settings, since, now: NOW, logger: logger(), stuck, out_of_time: () => false });

  it('halves the window to find the slice that fails, and passes it over after a few passes, with a warning', async () => {
    const { source } = sourceWith(() => new Error('The Email connector returned an incomplete metadata page.'));
    const warnings = logger();
    const seen: string[] = [];
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
      });
      seen.push(...found.raise.map(event => event.id));
      stuck = found.stuck;
      if (found.resume_from === undefined) {
        break;
      }
      since = found.resume_from;
    }
    expect(passes).toBeLessThan(80);
    expect(seen).toEqual(['bill_due:a', 'bill_due:c']);
    expect(warnings.warn).toHaveBeenCalledWith(
      'Passed over mail that the mail server could not list',
      expect.objectContaining({ passes: MAX_STUCK_PASSES }),
    );
  });

  it('stops the pass and counts the failing slice until it is passed over', async () => {
    const { source } = sourceWith(() => new Error('The Email connector returned an incomplete metadata page.'));
    let since = SINCE;
    let found = await pass({ source, since });
    // The first passes read the good mail before the slice and move on to it.
    for (let guard = 0; guard < 40 && found.stopped_by === undefined; guard += 1) {
      since = found.resume_from ?? since;
      found = await pass({ source, since });
    }
    expect(found.stopped_by).toBeDefined();
    expect(found.stuck?.passes).toBe(1);
    expect(found.resume_from).toEqual(since);
    const again = await pass({ source, since, stuck: found.stuck });
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
    });
    expect(windows).toHaveLength(2);
    expect(found.stopped_by).toBeUndefined();
    expect(found.resume_from).toEqual(SINCE);
  });
});
