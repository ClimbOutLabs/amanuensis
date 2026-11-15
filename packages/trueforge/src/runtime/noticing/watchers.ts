import { APPROVAL_EXPIRY_MINUTES } from '@truefoundry/trueforge-core/core/permissions/approvalExpiry';
import type { Logger } from 'winston';

import type { MailCursor, StuckMessage } from '../../db/noticingStore';
import type { AlwaysImportantSender, NoticingEvent, ReachSettings } from '../../schemas/reach';
import { checkSender } from './authenticationResults';
import { findDeadline, looksLikeBill, saysPaid } from './deadlines';
import {
  MailSourceBusyError,
  MessageUnreadableError,
  type CalendarEventInfo,
  type CalendarSource,
  type CursorMailSource,
  type CursorMessage,
  type MailMessage,
  type MailSource,
  type MailWindowRead,
  type TimedMailSource,
  type WaitingApproval,
} from './sources';

/** A bill is raised when it falls due within this long. */
export const BILL_WINDOW_MS = 3 * 86_400_000;
/** A bill due further off than this is not tracked. */
const BILL_TRACK_LIMIT_MS = 62 * 86_400_000;
/** The part of a message the watchers and the model read. */
const READ_CHARACTERS = 1500;
/** Calendar clashes are looked for this far ahead. */
const CLASH_WINDOW_MS = 24 * 3_600_000;
/** Most new messages one pass reads. */
const MAIL_PASS_LIMIT = 100;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function senderLabel(message: MailMessage): string {
  return message.from_name === null ? message.from_address : `${message.from_name} (${message.from_address})`;
}

function localDate({ at, timezone }: { at: Date; timezone: string }): string {
  try {
    return at.toLocaleDateString('en-US', { timeZone: timezone, weekday: 'long', month: 'long', day: 'numeric' });
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** A message the mail server keeps failing on, or a stretch of mail it cannot list, is passed over after this many passes. */
export const MAX_STUCK_PASSES = 3;
/**
 * A message that has held up passes this long, while other messages read fine, is passed over whatever the failure
 * was, so a message that never reads cannot stop mail for good.
 */
const STUCK_BACKSTOP_AFTER_MS = 3 * 3_600_000;

/** A stretch of mail that cannot be listed is counted under where it starts, since no message is to blame. */
function listSliceKey(from: Date): string {
  return `list:${new Date(floorGrid(from.getTime())).toISOString()}`;
}

/**
 * What one pass over new mail found. `track` are bills due later than the window, kept until they come near. When
 * `resume_from` is set, the next pass starts there; only a pass that leaves it unset read to the end of its window.
 * `stopped_by` is the failure that ended the pass early, and `stuck` the message (or stretch of mail) it keeps stopping
 * at, to carry into the next pass. `cursor` is where an IMAP pass resumes.
 */
export interface MailFindings {
  raise: NoticingEvent[];
  /** Mail passed over without being read; the caller tells about the whole stretch in one note. */
  gaps: LeftBehind[];
  track: NoticingEvent[];
  resume_from: Date | undefined;
  stuck: StuckMessage | undefined;
  stopped_by: { error: unknown } | undefined;
  /** The pass ran out of time or calls before it read to the end of its window. */
  timed_out: boolean;
  /** Where the next pass lists from, for a source that numbers its mail. */
  cursor: MailCursor | undefined;
}

/** A window this short that still holds more than one pass reads is read whole, up to this many messages. */
export const SHORTEST_WINDOW_MS = 4000;
const MOST_IN_SHORTEST_WINDOW = 500;
const GRID_MS = SHORTEST_WINDOW_MS;

function floorGrid(ms: number): number {
  return Math.floor(ms / GRID_MS) * GRID_MS;
}

function ceilGrid(ms: number): number {
  return Math.ceil(ms / GRID_MS) * GRID_MS;
}

/** A stretch of mail that arrived between two times and was left unread, so the person can be told. */
export interface LeftBehind {
  from: Date;
  to: Date;
}

interface WindowEnd {
  resume_from: Date | undefined;
  /** The end of the window this read listed. */
  before: Date;
  /** Mail in this window that was passed over without being read: a flood, or messages the server cannot list. */
  left_behind: LeftBehind[];
}

/** Reading stopped before any mail was read, or some was; only a read window carries messages. */
export type MailWindow =
  | (WindowEnd & {
      status: 'read';
      messages: MailMessage[];
      /** Where a source that numbers its mail got to after these messages. */
      cursor?: MailCursor | undefined;
      /** The few seconds of mail that cannot be listed, when some lists worked and this stretch fails alone. */
      unlistable?: { from: Date; to: Date; error: unknown };
    })
  | (WindowEnd & { status: 'timed_out' })
  /** No list worked, so the trouble is the account or the server and not a stretch of mail. */
  | (WindowEnd & { status: 'list_failed'; error: unknown });

interface WindowInput {
  source: TimedMailSource;
  since: Date;
  now: Date;
  limit: number;
  keep_from: readonly string[];
  logger: Pick<Logger, 'warn'>;
  out_of_time: () => boolean;
}

/** Where the next pass starts after a window that ended at `before`: nowhere in particular once it reached now. */
function resumeAfter({ before, now }: { before: Date; now: Date }): Date | undefined {
  return before.getTime() >= now.getTime() ? undefined : before;
}

/**
 * The oldest mail since `since` that one pass can read, and where the next pass starts. The window is halved until
 * the mail in it fits, so every message before `resume_from` was read and none is skipped. A flood too big to read
 * even in the shortest window is passed over, except mail from `keep_from`, so a flood cannot hide that mail.
 *
 * A list that fails for a reason other than a busy server is looked into only when some list worked: a short list at
 * the start, and one at the end, tell a failing account from a failing stretch of mail. Then the window is searched
 * for the few seconds that fail alone, the mail before them is read, and the pass goes on after them.
 */
export async function readMailWindow(input: WindowInput): Promise<MailWindow> {
  const { source, since, now, limit, keep_from, logger, out_of_time } = input;
  let before = now;
  let worked = false;
  for (;;) {
    if (out_of_time()) {
      return { status: 'timed_out', resume_from: since, before, left_behind: [] };
    }
    const short = before.getTime() - since.getTime() <= SHORTEST_WINDOW_MS;
    let read: MailWindowRead;
    try {
      read = await source.listNewMessages({
        since,
        before,
        limit: short ? MOST_IN_SHORTEST_WINDOW : limit,
        out_of_time,
      });
    } catch (error) {
      if (error instanceof MailSourceBusyError) {
        throw error;
      }
      return await locateFailure({ input, before, error, worked });
    }
    worked = true;
    if (read.read === 'all') {
      return {
        status: 'read',
        messages: read.messages,
        resume_from: resumeAfter({ before, now }),
        before,
        left_behind: [],
      };
    }
    if (read.read === 'oldest') {
      // Everything up to the newest message read was read. With none read, the next pass tries the same window.
      return {
        status: 'read',
        messages: read.messages,
        resume_from: read.messages.at(-1)?.received_at ?? since,
        before,
        left_behind: [],
      };
    }
    if (short) {
      const flood = await readFlood({ source, since, before, keep_from, logger, out_of_time });
      return {
        status: 'read',
        messages: flood.messages,
        resume_from: resumeAfter({ before, now }),
        before,
        left_behind: [flood.left],
      };
    }
    before = halfway({ since, before });
  }
}

/**
 * Searches a window that failed to list for the few seconds that fail alone. The mail before them is read, a flood in
 * the way is passed over, and the pass goes on with the mail after them.
 */
async function locateFailure({
  input,
  before,
  error,
  worked,
}: {
  input: WindowInput;
  before: Date;
  error: unknown;
  worked: boolean;
}): Promise<MailWindow> {
  const { source, since, now, limit, keep_from, logger, out_of_time } = input;
  const messages: MailMessage[] = [];
  const left_behind: LeftBehind[] = [];
  const list = async ({ from, to }: { from: number; to: number }): Promise<MailWindowRead> =>
    await source.listNewMessages({
      since: new Date(from),
      before: new Date(to),
      limit: to - from <= SHORTEST_WINDOW_MS ? MOST_IN_SHORTEST_WINDOW : limit,
      out_of_time,
    });
  /** Takes what a list of `[from, to)` found: its messages, or for a flood only the mail that matters. */
  const take = async ({ read, from, to }: { read: MailWindowRead; from: number; to: number }): Promise<void> => {
    if (read.read === 'all') {
      messages.push(...read.messages);
    } else if (read.read === 'too_many') {
      const flood = await readFlood({
        source,
        since: new Date(from),
        before: new Date(to),
        keep_from,
        logger,
        out_of_time,
      });
      messages.push(...flood.messages);
      left_behind.push(flood.left);
    }
  };
  const stopped: MailWindow = { status: 'list_failed', resume_from: since, before, error, left_behind: [] };
  let hi = ceilGrid(before.getTime());
  let lo = since.getTime();
  if (!worked) {
    if (out_of_time()) {
      return { status: 'timed_out', resume_from: since, before, left_behind: [] };
    }
    // A list at the start, and if that fails one at the end: when neither works the account or server is failing, and
    // nothing is passed over.
    const end = Math.min(floorGrid(lo) + GRID_MS, hi);
    try {
      const control = await list({ from: lo, to: end });
      await take({ read: control, from: lo, to: end });
      lo = control.read === 'oldest' ? lo : end;
    } catch (controlError) {
      if (controlError instanceof MailSourceBusyError) {
        throw controlError;
      }
      if (hi - GRID_MS <= lo) {
        return stopped;
      }
      if (out_of_time()) {
        return { status: 'timed_out', resume_from: since, before, left_behind: [] };
      }
      try {
        await list({ from: hi - GRID_MS, to: hi });
      } catch (endError) {
        if (endError instanceof MailSourceBusyError) {
          throw endError;
        }
        return stopped;
      }
    }
  }
  while (hi - lo > GRID_MS && !out_of_time()) {
    const mid = floorGrid(lo + Math.floor((hi - lo) / 2));
    if (mid <= lo) {
      break;
    }
    try {
      const read = await list({ from: lo, to: mid });
      if (read.read === 'oldest') {
        break;
      }
      await take({ read, from: lo, to: mid });
      lo = mid;
    } catch (searchError) {
      if (searchError instanceof MailSourceBusyError) {
        throw searchError;
      }
      hi = mid;
    }
  }
  const reached = new Date(lo);
  if (out_of_time()) {
    return messages.length === 0
      ? { status: 'timed_out', resume_from: reached, before, left_behind }
      : { status: 'read', messages, resume_from: reached, before, left_behind };
  }
  const cell = { from: reached, to: new Date(hi) };
  let cellRead: MailWindowRead;
  try {
    cellRead = await list({ from: lo, to: hi });
  } catch (cellError) {
    if (cellError instanceof MailSourceBusyError) {
      throw cellError;
    }
    return {
      status: 'read',
      messages,
      resume_from: cell.from,
      before,
      left_behind,
      unlistable: { ...cell, error: cellError },
    };
  }
  if (cellRead.read === 'oldest') {
    return { status: 'read', messages, resume_from: cell.from, before, left_behind };
  }
  await take({ read: cellRead, from: lo, to: hi });
  if (hi >= before.getTime()) {
    return { status: 'read', messages, resume_from: resumeAfter({ before, now }), before, left_behind };
  }
  // The few seconds that failed are read or left out, so the pass goes on with the mail after them.
  let rest: MailWindow;
  try {
    rest = await readMailWindow({ ...input, since: cell.to });
  } catch (restError) {
    if (restError instanceof MailSourceBusyError) {
      // What was found around the cell is kept, and the next pass meets the busy server itself.
      return { status: 'read', messages, resume_from: cell.to, before, left_behind };
    }
    throw restError;
  }
  if (rest.status !== 'read') {
    // What was read before the rest of the window stays read, and the next pass starts after it.
    return {
      status: 'read',
      messages,
      resume_from: rest.status === 'timed_out' ? rest.resume_from : cell.to,
      before,
      left_behind: [...left_behind, ...rest.left_behind],
    };
  }
  return { ...rest, messages: [...messages, ...rest.messages], left_behind: [...left_behind, ...rest.left_behind] };
}

function halfway({ since, before }: { since: Date; before: Date }): Date {
  return new Date(since.getTime() + Math.floor((before.getTime() - since.getTime()) / 2));
}

/**
 * A few hundred messages within a few seconds are a flood, not mail to tell anyone about. Only `keep_from` is read,
 * and the rest of the window is reported as left behind.
 */
async function readFlood({
  source,
  since,
  before,
  keep_from,
  logger,
  out_of_time,
}: {
  source: TimedMailSource;
  since: Date;
  before: Date;
  keep_from: readonly string[];
  logger: Pick<Logger, 'warn'>;
  out_of_time: () => boolean;
}): Promise<{ messages: MailMessage[]; left: LeftBehind }> {
  const window = { since: since.toISOString(), before: before.toISOString() };
  const left = { from: since, to: before };
  // Where no sender can be confirmed, mail from those senders is ordinary mail, so reading it is not worth a call.
  const kept =
    keep_from.length === 0 || source.trustedAuthenticationServers.length === 0 || out_of_time()
      ? undefined
      : await source.listNewMessages({ since, before, limit: MOST_IN_SHORTEST_WINDOW, from: keep_from, out_of_time });
  if (kept === undefined || kept.read === 'too_many') {
    logger.warn('Passed over a flood of mail that arrived within a few seconds', window);
    return { messages: [], left };
  }
  // A flood is read once, so a read that ran out of time is not tried again: the rest of the flood is passed over too.
  logger.warn('Read only mail from always-important senders in a flood of mail that arrived within a few seconds', {
    ...window,
    whole: kept.read === 'all',
  });
  return { messages: kept.messages, left };
}

/** Stops a message's read when the pass has used its time, before another call is made. */
class OutOfTime extends Error {
  constructor() {
    super('The pass ran out of time.');
    this.name = 'OutOfTime';
  }
}

/** A message that failed, or that the pass stopped at, and what it failed with. */
interface Failed {
  message: MailMessage;
  error: unknown;
}

const MOST_LISTED_PER_CALL = 500;
const MOST_LISTED_PER_PASS = 2000;

function isCursorMessage(message: MailMessage): message is CursorMessage {
  return 'uid' in message && typeof message.uid === 'number';
}

/**
 * The mail after a cursor, in the order the server numbered it. A bad message costs only itself, since the cursor
 * moves past it, and a pass that lists many messages simply reads them over several passes: nothing is searched for.
 */
async function readAfterCursor({
  source,
  since,
  now,
  cursor,
  logger,
  out_of_time,
}: {
  source: CursorMailSource;
  since: Date;
  now: Date;
  cursor: MailCursor | undefined;
  logger: Pick<Logger, 'warn'>;
  out_of_time: () => boolean;
}): Promise<MailWindow> {
  if (out_of_time()) {
    return { status: 'timed_out', resume_from: since, before: now, left_behind: [] };
  }
  const messages: CursorMessage[] = [];
  let skipped = 0;
  let position = cursor;
  let more = false;
  let listedOnce = false;
  while (!listedOnce || (more && messages.length < MOST_LISTED_PER_PASS && !out_of_time())) {
    try {
      const read = await source.listAfter({ cursor: position, since, limit: MOST_LISTED_PER_CALL, out_of_time });
      messages.push(...read.messages);
      skipped += read.skipped;
      // A call made after the dating was done says nothing of it, but a pass that stops at an earlier message
      // moves the cursor back below the dated UIDs, so they keep their time for the whole pass.
      const kept = position?.uidvalidity === read.cursor.uidvalidity ? position.dated : undefined;
      position = { ...read.cursor, dated: read.cursor.dated ?? kept };
      more = read.more;
      listedOnce = true;
    } catch (error) {
      if (!listedOnce) {
        if (error instanceof MailSourceBusyError) {
          throw error;
        }
        return { status: 'list_failed', resume_from: since, before: now, error, left_behind: [] };
      }
      // What an earlier call listed is kept, and the next pass lists on from there.
      more = true;
      break;
    }
  }
  if (skipped > 0) {
    logger.warn('Left out mail the mail server could not list', { skipped });
  }
  return {
    status: 'read',
    messages,
    cursor: position,
    resume_from: more ? (messages.at(-1)?.received_at ?? since) : undefined,
    before: now,
    // A skipped message's arrival is unknown, but it came after the mail the last pass read, so from `since` on.
    left_behind: skipped > 0 ? [{ from: since, to: now }] : [],
  };
}

async function listMail({
  source,
  since,
  now,
  cursor,
  always,
  logger,
  out_of_time,
}: {
  source: MailSource;
  since: Date;
  now: Date;
  cursor: MailCursor | undefined;
  always: ReadonlyMap<string, AlwaysImportantSender>;
  logger: Pick<Logger, 'warn'>;
  out_of_time: () => boolean;
}): Promise<MailWindow> {
  return 'listAfter' in source
    ? await readAfterCursor({ source, since, now, cursor, logger, out_of_time })
    : await readMailWindow({
        source,
        since,
        now,
        limit: MAIL_PASS_LIMIT,
        keep_from: [...always.keys()],
        logger,
        out_of_time,
      });
}

/**
 * Mail from someone the person marked always important, when the mail server vouched for the sender, and bills or
 * deadlines named in any new mail. A message from an always-important address that the server did not vouch for is
 * handled as ordinary mail: it can still be a bill, but only as a note.
 *
 * A failed read is one of three kinds. A message the source can never read is passed over at once. Any other failure
 * waits for the next message whose read worked, and then the failing message is tried once more. A failure that
 * survives the retry counts as a failed pass for the message if it is unclear, and does not count if it says the
 * server is busy. A message that fails `MAX_STUCK_PASSES` counted passes is passed over. A message that has held up
 * mail for `STUCK_BACKSTOP_AFTER_MS` is passed over too, but only after a retry that followed a working read, so a
 * server that fails on everything never makes the pass skip a message. Both come with a fixed note when the message
 * looked like a bill or came from an always-important sender. Two failures with no working read between stop the pass
 * at the first of them.
 *
 * The next pass starts at the earliest message not read, so no failure holds up mail for good and none loses what
 * the messages before it found. A pass that runs out of time stops there without counting anything, and an IMAP pass,
 * which cannot resume at a message, lists a shorter window next time.
 */
export async function watchMail({
  source,
  settings,
  since,
  now,
  logger,
  stuck,
  out_of_time,
  assistant,
  cursor,
}: {
  source: MailSource;
  settings: ReachSettings;
  since: Date;
  now: Date;
  logger: Pick<Logger, 'warn'>;
  /** Where the last pass of a source that numbers its mail got to, if it did. */
  cursor?: MailCursor | undefined;
  /** The message or stretch of mail the last pass stopped at, when it did. */
  stuck: StuckMessage | undefined;
  /** Whether the pass has used the time or calls it has, so it stops cleanly before its connection ends. */
  out_of_time: () => boolean;
  /** What the person calls their assistant, for the notes about mail it could not read. */
  assistant: string;
}): Promise<MailFindings> {
  const always = new Map(settings.always_important.map(sender => [sender.address, sender]));
  const window = await listMail({ source, since, now, cursor, always, logger, out_of_time });
  if (window.status === 'list_failed') {
    return {
      raise: [],
      gaps: [],
      track: [],
      resume_from: since,
      stuck,
      stopped_by: { error: window.error },
      timed_out: false,
      cursor,
    };
  }
  const findings = {
    raise: new Array<NoticingEvent>(),
    gaps: [...window.left_behind],
    track: new Array<NoticingEvent>(),
  };
  if (window.status === 'timed_out') {
    // Nothing was read, so the pass shows it fell behind.
    return {
      ...findings,
      resume_from: window.resume_from ?? since,
      stuck,
      stopped_by: undefined,
      timed_out: true,
      cursor,
    };
  }
  const { messages } = window;
  const stuckFor = ({ message_id, passes }: { message_id: string; passes: number }): StuckMessage => ({
    message_id,
    passes,
    since: stuck?.message_id === message_id ? stuck.since : now,
  });
  const state: {
    /** A count from an earlier pass, carried on only while its message is still in the window. */
    carried: StuckMessage | undefined;
    /** The first message the next pass must read again, if any. */
    open: MailMessage | undefined;
    /** A failure waiting for a read of a later message to work before it is tried again. */
    unconfirmed: Failed | undefined;
    /** A failure that survived its retry and was not passed over: the message the next pass starts at. */
    held: { failed: StuckMessage; error: unknown } | undefined;
    stoppedBy: { error: unknown } | undefined;
    timedOut: boolean;
  } = {
    carried: stuck !== undefined && messages.some(message => message.id === stuck.message_id) ? stuck : undefined,
    open: undefined,
    unconfirmed: undefined,
    held: undefined,
    stoppedBy: undefined,
    timedOut: false,
  };

  const attempt = async (
    message: MailMessage,
  ): Promise<{ found: Awaited<ReturnType<typeof findInMessage>> } | { error: unknown } | 'out_of_time'> => {
    try {
      return { found: await findInMessage({ source, message, settings, always, now, logger, out_of_time }) };
    } catch (error) {
      return error instanceof OutOfTime ? 'out_of_time' : { error };
    }
  };

  /**
   * Settles a failure that survived its retry: passes the message over, or holds it as where the next pass starts. It
   * runs only after a read of another message worked, so a failure that comes from the server alone never gets here.
   */
  const settle = ({ message, error }: Failed): void => {
    const busy = error instanceof MailSourceBusyError;
    const carried = state.carried?.message_id === message.id ? state.carried : undefined;
    const passes = busy ? (carried?.passes ?? 0) : (carried?.passes ?? 0) + 1;
    const backstop = carried !== undefined && now.getTime() - carried.since.getTime() >= STUCK_BACKSTOP_AFTER_MS;
    if ((!busy && passes >= MAX_STUCK_PASSES) || backstop) {
      logger.warn('Passed over a mail the mail server kept failing on', {
        message_id: message.id,
        passes,
        error: loggedError(error),
      });
      const note = unreadNote({ message, always, settings, assistant });
      if (note !== undefined) {
        findings.raise.push(note);
      }
      state.carried = carried === undefined ? state.carried : undefined;
      state.open = state.open === message ? undefined : state.open;
      return;
    }
    state.held = { failed: stuckFor({ message_id: message.id, passes }), error };
  };

  /** A message the server says it can never give is skipped at once, with a note when it may have mattered. */
  const passOver = ({ message, error }: Failed): void => {
    logger.warn('Passed over a mail that could not be read', { message_id: message.id, error: loggedError(error) });
    const note = unreadNote({ message, always, settings, assistant });
    if (note !== undefined) {
      findings.raise.push(note);
    }
  };

  for (const message of messages) {
    if (out_of_time()) {
      state.open ??= message;
      state.timedOut = true;
      break;
    }
    const result = await attempt(message);
    if (result === 'out_of_time') {
      state.open ??= message;
      state.timedOut = true;
      break;
    }
    if ('found' in result) {
      findings.raise.push(...result.found.raise);
      findings.track.push(...result.found.track);
      state.carried = state.carried?.message_id === message.id ? undefined : state.carried;
      if (result.found.served && state.unconfirmed !== undefined) {
        // A read worked after the failure, so the failing message is tried once more. Only a failure that
        // survives says something about the message.
        const failed = state.unconfirmed;
        state.unconfirmed = undefined;
        const again = await attempt(failed.message);
        if (again === 'out_of_time') {
          state.timedOut = true;
          break;
        }
        if ('found' in again) {
          findings.raise.push(...again.found.raise);
          findings.track.push(...again.found.track);
          state.carried = state.carried?.message_id === failed.message.id ? undefined : state.carried;
          state.open = state.open === failed.message ? undefined : state.open;
        } else if (again.error instanceof MessageUnreadableError) {
          passOver({ message: failed.message, error: again.error });
          state.carried = state.carried?.message_id === failed.message.id ? undefined : state.carried;
          state.open = state.open === failed.message ? undefined : state.open;
        } else {
          settle({ message: failed.message, error: again.error });
        }
      }
      continue;
    }
    if (result.error instanceof MessageUnreadableError) {
      passOver({ message, error: result.error });
      state.carried = state.carried?.message_id === message.id ? undefined : state.carried;
      continue;
    }
    state.open ??= message;
    if (state.unconfirmed !== undefined || state.held !== undefined) {
      // A second failure with no working read between says nothing about either message.
      state.stoppedBy = { error: result.error };
      break;
    }
    state.unconfirmed = { message, error: result.error };
  }
  if (state.unconfirmed !== undefined && !state.timedOut) {
    // No read worked after it, so it cannot be tried again, and nothing says the message is to blame.
    state.stoppedBy ??= { error: state.unconfirmed.error };
  }
  const { held, unconfirmed } = state;
  // A pass that stops at a message remembers which one, so a message that keeps stopping passes is known.
  const stoppedAt = unconfirmed?.message ?? state.open;
  const stopIdentity: StuckMessage | undefined =
    stoppedAt === undefined || state.stoppedBy === undefined
      ? undefined
      : stuckFor({
          message_id: stoppedAt.id,
          passes: state.carried?.message_id === stoppedAt.id ? state.carried.passes : 0,
        });
  const slice =
    window.unlistable === undefined ? undefined : countSlice({ slice: window.unlistable, stuck, now, logger });
  if (slice?.gap !== undefined) {
    findings.gaps.push(slice.gap);
  }
  const open = state.open;
  const resume_from = open !== undefined ? open.received_at : (slice?.resume_from ?? window.resume_from);
  let stopped = state.stoppedBy ?? (held === undefined ? undefined : { error: held.error });
  stopped ??= slice?.error === undefined ? undefined : { error: slice.error };
  return {
    ...findings,
    resume_from,
    stuck: held?.failed ?? stopIdentity ?? slice?.stuck ?? state.carried,
    stopped_by: stopped,
    timed_out: state.timedOut,
    // Everything before the first message left to read was read or passed over.
    cursor:
      window.cursor === undefined
        ? undefined
        : settled(
            open === undefined || !isCursorMessage(open) ? window.cursor : { ...window.cursor, last_uid: open.uid - 1 },
          ),
  };
}

/** A cursor as it is kept: the dated UIDs only while some are still ahead of it. */
function settled(cursor: MailCursor): MailCursor {
  return cursor.dated !== undefined && cursor.last_uid < cursor.dated.to_uid ? cursor : { ...cursor, dated: undefined };
}

/** A stretch of mail that cannot be listed is counted like a message, and passed over after the same passes. */
function countSlice({
  slice,
  stuck,
  now,
  logger,
}: {
  slice: { from: Date; to: Date; error: unknown };
  stuck: StuckMessage | undefined;
  now: Date;
  logger: Pick<Logger, 'warn'>;
}): { resume_from: Date; stuck: StuckMessage | undefined; error: unknown; gap?: LeftBehind } {
  const key = listSliceKey(slice.from);
  const passes = stuck?.message_id === key ? stuck.passes + 1 : 1;
  if (passes < MAX_STUCK_PASSES) {
    return {
      resume_from: slice.from,
      stuck: { message_id: key, passes, since: stuck?.message_id === key ? stuck.since : now },
      error: slice.error,
    };
  }
  logger.warn('Passed over mail that the mail server could not list', {
    since: slice.from.toISOString(),
    before: slice.to.toISOString(),
    passes,
    error: loggedError(slice.error),
  });
  return {
    resume_from: slice.to,
    stuck: undefined,
    error: undefined,
    gap: { from: slice.from, to: slice.to },
  };
}

/** A time in the person's own words and zone, with the day, for a note that names mail they must go and find. */
function localWhen({ at, timezone, day = true }: { at: Date; timezone: string; day?: boolean }): string {
  try {
    return at.toLocaleString('en-US', {
      timeZone: timezone,
      weekday: 'short',
      ...(day ? { month: 'short', day: 'numeric' } : {}),
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return at.toISOString();
  }
}

/** What events about a message are named by. */
function eventKeyOf(message: MailMessage): string {
  return message.key ?? message.id;
}

/**
 * A fixed note that some mail could not be read, naming when it arrived so the person can look for it. One note covers
 * a whole stretch of trouble: while the stretch goes on it says "from", because more mail may still be passed over.
 */
export function gapNote({
  gap,
  stretch,
  ongoing,
  settings,
  assistant,
}: {
  gap: LeftBehind;
  /** Names the stretch, so every pass of it makes the same note and the person is told once. */
  stretch: Date;
  ongoing: boolean;
  settings: ReachSettings;
  assistant: string;
}): NoticingEvent {
  const from = localWhen({ at: gap.from, timezone: settings.timezone });
  const to = localWhen({ at: gap.to, timezone: settings.timezone });
  const when = ongoing ? `from ${from} on` : from === to ? `around ${from}` : `between ${from} and ${to}`;
  return {
    id: `mail_gap:${stretch.toISOString()}`,
    kind: 'mail_always',
    evidence: 'content',
    summary: `${assistant} could not read some mail that arrived ${when}. Open your mail to check it.`,
    facts: `${assistant} could not read some mail that arrived ${when}.`,
    matched: 'Some mail could not be read, so it may hold something that matters.',
    link: null,
    mail_ref: null,
    occurred_at: gap.from.toISOString(),
    due_at: null,
  };
}

/** A fixed note for a message that could not be read but may matter: it looked like a bill or came from a listed sender. */
function unreadNote({
  message,
  always,
  settings,
  assistant,
}: {
  message: MailMessage;
  always: ReadonlyMap<string, AlwaysImportantSender>;
  settings: ReachSettings;
  assistant: string;
}): NoticingEvent | undefined {
  const listed = always.has(message.from_address.toLowerCase());
  if (!listed && !looksLikeBill(`${message.subject}\n${message.snippet}`)) {
    return undefined;
  }
  const kind = listed ? 'mail_always' : 'bill_due';
  const when = localWhen({ at: message.received_at, timezone: settings.timezone });
  const from = clip(message.from_address, 80);
  return {
    id: `${kind}:${eventKeyOf(message)}`,
    kind,
    evidence: 'content',
    summary: `A message from ${from} that arrived ${when} could not be read, and it may matter. Open your mail to check it.`,
    facts: `${assistant} could not read one message from ${from} that arrived ${when}, and it looked like it may matter.`,
    matched: `${assistant} could not read this message. It looked like a bill or came from someone you marked always important.`,
    link: null,
    mail_ref: { message_id: message.id, thread_id: message.thread_id },
    occurred_at: message.received_at.toISOString(),
    due_at: null,
  };
}

function causeText(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return error.cause instanceof Error ? error.cause.message : error.message;
}

/** What to log for a failure: a busy server's cause can name a host, so only its fixed words are kept. */
function loggedError(error: unknown): string {
  return error instanceof MailSourceBusyError ? error.message : causeText(error);
}

async function findInMessage({
  source,
  message,
  settings,
  always,
  now,
  logger,
  out_of_time,
}: {
  source: MailSource;
  message: MailMessage;
  settings: ReachSettings;
  always: ReadonlyMap<string, AlwaysImportantSender>;
  now: Date;
  logger: Pick<Logger, 'warn'>;
  out_of_time: () => boolean;
}): Promise<Pick<MailFindings, 'raise' | 'track'> & { served: boolean }> {
  const found: Pick<MailFindings, 'raise' | 'track'> & { served: boolean } = { raise: [], track: [], served: false };
  /** Reads a message's text, and notes that the server answered. */
  const readText = async (item: MailMessage): Promise<string> => {
    if (out_of_time()) {
      throw new OutOfTime();
    }
    const text = await source.readText(item);
    found.served = true;
    return text;
  };
  const listed = always.get(message.from_address.toLowerCase());
  const verified =
    listed !== undefined &&
    checkSender({
      from_address: message.from_address,
      headers: message.authentication_results,
      trusted_servers: source.trustedAuthenticationServers,
    }).verified;
  if (listed !== undefined && verified) {
    const text = clip(await readText(message), READ_CHARACTERS);
    const who = listed.name ?? message.from_name ?? message.from_address;
    found.raise.push({
      id: `mail_always:${eventKeyOf(message)}`,
      kind: 'mail_always',
      evidence: 'verified_sender',
      summary: clip(`New mail from ${who}: ${message.subject}`, 300),
      facts: [`From: ${senderLabel(message)}`, `Subject: ${message.subject}`, `Start of the message: ${text}`].join(
        '\n',
      ),
      matched: `${who} is on your always-important list and the mail server confirmed the sender.`,
      link: null,
      mail_ref: { message_id: message.id, thread_id: message.thread_id },
      occurred_at: message.received_at.toISOString(),
      due_at: null,
    });
  }
  const bill = await billFrom({ readText, message, settings, verified, now });
  if (bill === undefined) {
    return found;
  }
  if (bill.due_at !== null && new Date(bill.due_at).getTime() - now.getTime() > BILL_WINDOW_MS) {
    // A bill due later is kept without a thread check, which is made when it comes near.
    found.track.push(bill);
    return found;
  }
  // A thread that cannot be checked says nothing about the message itself, so the bill is kept to be checked again
  // with the tracked bills, and is raised once it is close to due.
  // With no time left the thread is not checked, and the bill is kept to be checked with the tracked bills.
  const paid = await (out_of_time() ? Promise.resolve(undefined) : billIsPaid({ source, event: bill })).then(
    value => {
      found.served = true;
      return value;
    },
    (error: unknown) => {
      logger.warn('Could not check whether a bill was paid; it is checked again later', {
        message_id: message.id,
        error: loggedError(error),
      });
      return undefined;
    },
  );
  if (paid === true) {
    return found;
  }
  if (paid === undefined) {
    found.track.push(bill);
  } else if (found.raise.length === 0) {
    // Mail already raised for its sender is not raised a second time as a bill.
    found.raise.push(bill);
  }
  return found;
}

async function billFrom({
  readText,
  message,
  settings,
  verified,
  now,
}: {
  readText: (message: MailMessage) => Promise<string>;
  message: MailMessage;
  settings: ReachSettings;
  verified: boolean;
  now: Date;
}): Promise<NoticingEvent | undefined> {
  if (!looksLikeBill(`${message.subject}\n${message.snippet}`)) {
    return undefined;
  }
  const text = clip(await readText(message), READ_CHARACTERS * 2);
  const due = findDeadline({
    text: `${message.subject}\n${text}`,
    received_at: message.received_at,
    timezone: settings.timezone,
  });
  if (due === undefined || due.getTime() < now.getTime() || due.getTime() - now.getTime() > BILL_TRACK_LIMIT_MS) {
    return undefined;
  }
  const subject = clip(message.subject, 120);
  return {
    id: `bill_due:${eventKeyOf(message)}`,
    kind: 'bill_due',
    evidence: verified ? 'verified_sender' : 'content',
    summary: clip(`A bill or deadline is due ${localDate({ at: due, timezone: settings.timezone })}: ${subject}`, 300),
    facts: [
      `From: ${senderLabel(message)}`,
      `Subject: ${message.subject}`,
      `Due: ${due.toISOString()}`,
      `Start of the message: ${clip(text, READ_CHARACTERS)}`,
    ].join('\n'),
    matched: 'A message names this date as a due date, and nothing later says it was paid.',
    link: null,
    mail_ref: { message_id: message.id, thread_id: message.thread_id },
    occurred_at: message.received_at.toISOString(),
    due_at: due.toISOString(),
  };
}

/** Whether anything after the bill's message in its thread says it was paid. */
export async function billIsPaid({ source, event }: { source: MailSource; event: NoticingEvent }): Promise<boolean> {
  if (event.mail_ref === null) {
    return false;
  }
  const later = await source.laterInThread({
    id: event.mail_ref.message_id,
    thread_id: event.mail_ref.thread_id,
    received_at: new Date(event.occurred_at),
  });
  return later.some(saysPaid);
}

/** Clashes in the next 24 hours, and events with a place that start within the person's travel lead time. */
export async function watchCalendar({
  source,
  settings,
  now,
}: {
  source: CalendarSource;
  settings: ReachSettings;
  now: Date;
}): Promise<NoticingEvent[]> {
  const leadMs = settings.travel_lead_minutes * 60_000;
  const horizon = Math.max(CLASH_WINDOW_MS, leadMs);
  const events = await source.listEvents({ from: now, to: new Date(now.getTime() + horizon) });
  const found: NoticingEvent[] = [];
  const sorted = [...events].sort((a, b) => a.start.getTime() - b.start.getTime() || a.id.localeCompare(b.id));
  for (let i = 0; i < sorted.length; i += 1) {
    const first = sorted[i];
    if (first === undefined) {
      continue;
    }
    for (let j = i + 1; j < sorted.length; j += 1) {
      const second = sorted[j];
      if (second === undefined || second.start.getTime() >= first.end.getTime()) {
        break;
      }
      const overlapStart = Math.max(first.start.getTime(), second.start.getTime());
      if (overlapStart < now.getTime() || overlapStart > now.getTime() + CLASH_WINDOW_MS) {
        continue;
      }
      found.push(clashEvent({ first, second, timezone: settings.timezone }));
    }
    if (isTravel({ event: first, now, leadMs })) {
      found.push(travelEvent({ event: first, timezone: settings.timezone }));
    }
  }
  return found;
}

function clashEvent({
  first,
  second,
  timezone,
}: {
  first: CalendarEventInfo;
  second: CalendarEventInfo;
  timezone: string;
}): NoticingEvent {
  const [a, b] = [first, second].sort((x, y) => x.id.localeCompare(y.id));
  const left = a ?? first;
  const right = b ?? second;
  return {
    id: `calendar_clash:${left.id}@${left.start.toISOString()}:${right.id}@${right.start.toISOString()}`,
    kind: 'calendar_clash',
    evidence: first.own && second.own ? 'own' : 'content',
    summary: clip(
      `"${clip(first.title, 60)}" at ${localWhen({ at: first.start, timezone, day: false })} overlaps "${clip(second.title, 60)}" at ${localWhen({ at: second.start, timezone, day: false })}.`,
      300,
    ),
    facts: [
      `Event one: ${clip(first.title, 120)}, ${first.start.toISOString()} to ${first.end.toISOString()}`,
      `Event two: ${clip(second.title, 120)}, ${second.start.toISOString()} to ${second.end.toISOString()}`,
    ].join('\n'),
    matched: 'Two events on your calendar overlap in the next 24 hours.',
    link: null,
    mail_ref: null,
    occurred_at: new Date(Math.max(first.start.getTime(), second.start.getTime())).toISOString(),
    due_at: null,
  };
}

/** A place worth travelling to: it is written down, and it is not a video link. */
function hasPlace(location: string | null): location is string {
  return location !== null && location.trim() !== '' && !/^(https?:\/\/|www\.)/i.test(location.trim());
}

function isTravel({ event, now, leadMs }: { event: CalendarEventInfo; now: Date; leadMs: number }): boolean {
  const until = event.start.getTime() - now.getTime();
  return hasPlace(event.location) && until > 0 && until <= leadMs;
}

function travelEvent({ event, timezone }: { event: CalendarEventInfo; timezone: string }): NoticingEvent {
  return {
    id: `travel:${event.id}@${event.start.toISOString()}`,
    kind: 'travel',
    evidence: event.own ? 'own' : 'content',
    summary: clip(
      `"${clip(event.title, 80)}" starts at ${localWhen({ at: event.start, timezone, day: false })}. Time to head out.`,
      300,
    ),
    facts: [
      `Event: ${clip(event.title, 120)}`,
      `Starts: ${event.start.toISOString()}`,
      `Place: ${clip(event.location ?? '', 160)}`,
    ].join('\n'),
    matched: 'An event with a place starts within your travel lead time.',
    link: null,
    mail_ref: null,
    occurred_at: event.start.toISOString(),
    due_at: null,
  };
}

/** One person's open requests that have waited longer than the time they chose. */
export function watchApprovals({
  waiting,
  settings,
  now,
}: {
  waiting: readonly WaitingApproval[];
  settings: ReachSettings;
  now: Date;
}): NoticingEvent[] {
  const limitMs = settings.approval_wait_minutes * 60_000;
  const expiryMs = APPROVAL_EXPIRY_MINUTES * 60_000;
  // A request that has waited past its expiry is closed when the person opens the chat, so there is nothing to ask.
  return waiting
    .filter(item => {
      const waited = now.getTime() - item.waiting_since.getTime();
      return waited >= limitMs && waited < expiryMs;
    })
    .map(item => {
      const minutes = Math.max(1, Math.round((now.getTime() - item.waiting_since.getTime()) / 60_000));
      return {
        id: `approval_waiting:${item.session_id}:${item.approval_id}`,
        kind: 'approval_waiting',
        evidence: 'own',
        summary: `Something has been waiting for your ok for about ${String(minutes)} minutes. It closes after ${String(APPROVAL_EXPIRY_MINUTES)}.`,
        facts: `A request for the person's ok has waited about ${String(minutes)} minutes.`,
        matched: `An approval has waited longer than the ${String(settings.approval_wait_minutes)} minutes you chose.`,
        link: { type: 'approval', session_id: item.session_id, approval_id: item.approval_id },
        mail_ref: null,
        occurred_at: item.waiting_since.toISOString(),
        due_at: null,
      } satisfies NoticingEvent;
    });
}
