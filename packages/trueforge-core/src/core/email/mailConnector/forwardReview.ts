import { isRecord } from '../../util/records';
import { emailsOfResult } from './mailToolResults';
import { MAIL_ACCOUNT_ARGUMENT } from './toolContract';

/** The most of a forwarded message's text a card shows; the rest is marked as cut. */
const FORWARD_BODY_MAX_CHARS = 4000;

/** What a person needs to recognize the message a forward sends on. */
export interface MailForwardReview {
  from: string;
  subject: string;
  body: string;
  /** True when the message is longer than the part kept here. */
  truncated: boolean;
  /** Names of the files attached to the message. */
  attachments: string[];
}

/** The subject a forward goes out under: the message's own, marked as forwarded once. */
export function forwardedSubject(subject: string): string {
  return subject.toLowerCase().startsWith('fwd:') ? subject : `Fwd: ${subject}`;
}

/**
 * The read that fetches the message a forward names, from the same account and folder the forward uses.
 * Undefined when the call names no message.
 */
export function mailForwardReadArguments(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const id = args['email_id'];
  if (typeof id !== 'string' && typeof id !== 'number') {
    return undefined;
  }
  const account = args[MAIL_ACCOUNT_ARGUMENT];
  const mailbox = args['source_mailbox'];
  return {
    ...(typeof account === 'string' && account !== '' ? { [MAIL_ACCOUNT_ARGUMENT]: account } : {}),
    email_ids: [String(id)],
    ...(typeof mailbox === 'string' && mailbox !== '' ? { mailbox } : {}),
    mark_as_read: false,
  };
}

/** The message a forward sends on, from the content read's answer. Null when the answer does not hold that message. */
export function mailForwardReviewFrom({ id, result }: { id: string; result: unknown }): MailForwardReview | null {
  const email = emailsOfResult(result).find(entry => isRecord(entry) && String(entry['email_id']) === id);
  if (!isRecord(email)) {
    return null;
  }
  const { sender, subject, body, attachments } = email;
  if (typeof sender !== 'string' || typeof body !== 'string') {
    return null;
  }
  const characters = Array.from(body);
  return {
    from: sender,
    subject: typeof subject === 'string' ? subject : '',
    body: characters.slice(0, FORWARD_BODY_MAX_CHARS).join(''),
    truncated: characters.length > FORWARD_BODY_MAX_CHARS,
    attachments: Array.isArray(attachments) ? attachments.filter(name => typeof name === 'string') : [],
  };
}
