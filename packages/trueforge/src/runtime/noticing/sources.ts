import type { NoticingOwner } from '../../db/noticingStore';

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
}

/** Enough to find a message again: its id, its thread and when it came. */
export type MailRef = Pick<MailMessage, 'id' | 'thread_id' | 'received_at'>;

export interface MailSource {
  /**
   * Up to `limit` messages that reached the inbox at or after `since`, oldest first. Mail the person sent is left
   * out. `truncated` is true when newer messages were left for the next read.
   */
  listNewMessages(input: { since: Date; limit: number }): Promise<{ messages: MailMessage[]; truncated: boolean }>;
  /** The start of one message's text, for a watcher that needs more than the snippet. */
  readText(message: MailMessage): Promise<string>;
  /** The text of messages that came after this one in its thread, oldest first. */
  laterInThread(message: MailRef): Promise<string[]>;
  /** The receiving servers whose Authentication-Results can be believed. Empty when this source passes on none. */
  trustedAuthenticationServers: readonly string[];
}

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

export interface NoticingSources {
  mail: MailSource | undefined;
  calendar: CalendarSource | undefined;
}

/** A place that knows whose mail and calendar can be watched, and opens them. */
export interface NoticingSourceProvider {
  listOwners(): Promise<NoticingOwner[]>;
  sourcesFor(owner: NoticingOwner): Promise<NoticingSources>;
}

export interface WaitingApproval {
  /** Who the request is waiting on: the person whose chat asked for their ok. */
  owner: NoticingOwner;
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
