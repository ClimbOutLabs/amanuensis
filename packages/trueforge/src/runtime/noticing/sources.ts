import type { MailCursor } from '../../db/noticingStore';
import type { PersonOwner } from '../../db/personOwner';
import type { CalendarProblemKind, MailSourceKind } from '../../schemas/reach';

/**
 * What the watchers read. Each port answers a narrow question, so a mail or calendar source other than Google can be
 * added without touching the watchers. Everything they return is the person's own data, read with read-only calls.
 */

export interface MailMessage {
  /** The mail server's id for the message, stable across reads. */
  id: string;
  thread_id: string | null;
  from_address: string;
  from_name: string | null;
  subject: string;
  /** The start of the message text the mail server gives for a list. */
  snippet: string;
  received_at: Date;
  /** Every Authentication-Results header, topmost first. Empty when the mail server added none. */
  authentication_results: string[];
  /**
   * What events about the message are named by, when its id can change: on IMAP, its Message-ID with its sender, date
   * and subject, so a renumbered mailbox listing it again raises nothing new. Events use the id when there is none.
   */
  key?: string | undefined;
}

/** Enough to find a message again: its id, its thread and when it came. */
export type MailRef = Pick<MailMessage, 'id' | 'thread_id' | 'received_at'>;

/**
 * One read of the mail that reached the inbox in a window, by the mail server's own arrival time. `all` holds every
 * message in it, oldest first. `too_many` says the window holds more than was asked for, so a shorter one is needed.
 * `oldest` holds only the oldest part, because the source ran out of time.
 */
export type MailWindowRead =
  { read: 'all'; messages: MailMessage[] } | { read: 'too_many' } | { read: 'oldest'; messages: MailMessage[] };

/**
 * A read fails in one of three ways. This is the first: the message can never be read however often it is tried (it
 * was deleted, it is too large, or it comes back in a shape the source cannot parse), so it is passed over at once.
 * The second is `MailSourceBusyError`. Any other error is unclear: it may be about the message or about the
 * server, and counts against the message only once a read of another message worked after it.
 */
export class MessageUnreadableError extends Error {
  constructor({ cause }: { cause: unknown }) {
    super('This message could not be read.', { cause });
    this.name = 'MessageUnreadableError';
  }
}

/**
 * A read failed in a way that says nothing about the message: the server is busy, rate limiting, down, out of reach,
 * or the read ran out of time. Such a failure stops the pass but never counts toward passing the message over.
 */
export class MailSourceBusyError extends Error {
  constructor({ cause }: { cause: unknown }) {
    super('The mail server could not be reached or was too busy.', { cause });
    this.name = 'MailSourceBusyError';
  }
}

/** The Email connector could not log in to the mail account, so the person has to check the account's password. */
export class MailLoginFailedError extends MailSourceBusyError {
  constructor({ cause }: { cause: unknown }) {
    super({ cause });
    this.message = 'The Email connector could not log in to the mail account.';
    this.name = 'MailLoginFailedError';
  }
}

/** Said when mail took too long to read, so the person can be told why it was not checked. */
export class MailTooSlowError extends MailSourceBusyError {
  constructor({ cause }: { cause: unknown }) {
    super({ cause });
    this.message = 'Mail took too long to read. It is read again on the next check.';
    this.name = 'MailTooSlowError';
  }
}

interface MailReader {
  /** The start of one message's text, for a watcher that needs more than the snippet. Throws MessageUnreadableError for a message it can never read. */
  readText(message: MailMessage): Promise<string>;
  /** The text of messages that came after this one in its thread, oldest first. A later reply it cannot read is left out. */
  laterInThread(message: MailRef): Promise<string[]>;
  /** The receiving servers whose Authentication-Results can be believed. Empty when this source passes on none. */
  trustedAuthenticationServers: readonly string[];
}

/** A source that lists mail by when it arrived, and so resumes at the arrival of the first message it did not reach. */
export interface TimedMailSource extends MailReader {
  /**
   * Mail that reached the inbox at or after `since` and before `before`, from the `from` addresses only when given.
   * Mail the person sent is left out.
   */
  listNewMessages(input: {
    since: Date;
    before: Date;
    limit: number;
    from?: readonly string[];
    /** Whether the pass has used the time or calls it has. A long search checks it before every call it makes. */
    out_of_time: () => boolean;
  }): Promise<MailWindowRead>;
  /** Set when a list fetches every message it finds with a call of its own, so a pass counts those against its calls. */
  fetchesEachListed?: true;
}

/** A message listed after a cursor, with the number the mail server gave it. */
export type CursorMessage = MailMessage & { uid: number };

/**
 * A read of the mail after a cursor, in the order the server numbered it. `cursor` is the last message examined,
 * including any that could not be listed (`skipped`), and `more` says the batch was full.
 */
export interface CursorRead {
  messages: CursorMessage[];
  skipped: number;
  cursor: MailCursor;
  more: boolean;
}

/** A source that numbers its mail, so a pass resumes exactly after the last message it handled. */
export interface CursorMailSource extends MailReader {
  /**
   * Mail after `cursor`. With no cursor, or one for another mailbox generation, it starts at the first message that
   * arrived at or after `since`.
   */
  listAfter(input: {
    cursor: MailCursor | undefined;
    since: Date;
    limit: number;
    out_of_time: () => boolean;
  }): Promise<CursorRead>;
}

export type MailSource = TimedMailSource | CursorMailSource;

export interface CalendarEventInfo {
  id: string;
  title: string;
  start: Date;
  end: Date;
  location: string | null;
  /**
   * Whether the event is the person's own: they organised it, accepted it, or it has no one else on it. An invite
   * they have not accepted is someone else's words, so it can only ever raise a note.
   */
  own: boolean;
}

export interface CalendarSource {
  /** Timed events that overlap the window and are still on, so cancelled, declined and all-day events are left out. */
  listEvents(input: { from: Date; to: Date }): Promise<CalendarEventInfo[]>;
}

/** Whether a person's mail can be watched: a source, none set up, or one that is set up but could not be opened now. */
export type MailAccess =
  | { status: 'ready'; source: MailSource; kind: MailSourceKind }
  | { status: 'none' }
  | { status: 'unreachable'; error: unknown; kind: MailSourceKind };

/** Whether a person's calendar can be watched, as for mail. */
export type CalendarAccess =
  | { status: 'ready'; source: CalendarSource }
  | { status: 'none' }
  | { status: 'unreachable'; error: unknown; kind: CalendarProblemKind };

export interface NoticingSources {
  mail: MailAccess;
  calendar: CalendarAccess;
}

/** A place that knows whose mail and calendar can be watched, and opens them. */
export interface NoticingSourceProvider {
  listOwners(): Promise<PersonOwner[]>;
  sourcesFor(owner: PersonOwner): Promise<NoticingSources>;
}

export interface WaitingApproval {
  /** Who the request is waiting on: the person whose chat asked for their ok. */
  owner: PersonOwner;
  session_id: string;
  /** The request's own id, so the delivery can lead straight to it. */
  approval_id: string;
  /** When the request for the person's ok was made. */
  waiting_since: Date;
}

export interface ApprovalSource {
  /** Requests for someone's ok that are still open, for everyone at once. */
  listWaiting(): Promise<WaitingApproval[]>;
}
