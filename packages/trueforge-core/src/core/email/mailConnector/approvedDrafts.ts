import { createHash } from 'node:crypto';
import { isRecord } from '../../util/records';
import { normalizeMailAddress } from './recipientList';
import { MAIL_ACCOUNT_ARGUMENT, MAIL_FORWARD_TOOL_NAME } from './toolContract';

/**
 * The drafts a person approved and has not sent yet. A send goes out only when it matches one, so
 * no message is sent that the person did not first see and approve as a draft.
 */
export interface ApprovedMailDrafts {
  has: (input: ApprovedMailDraft) => Promise<boolean>;
  add: (input: ApprovedMailDraft) => Promise<void>;
  /** Removes the draft and says whether it was there, in one step, so one draft can back one send only. */
  take: (input: ApprovedMailDraft) => Promise<boolean>;
}

/** What the model is told when it sends a new message that matches no draft the person approved. */
export const MAIL_DRAFT_FIRST_DETAIL =
  'An email is saved as a draft and approved by the person before it can be sent. Save this message with save_draft first. Once the person approves the draft and asks for it to be sent, call send_email with exactly the same recipients, subject and body.';

export interface ApprovedMailDraft {
  tenant_id: string;
  created_by: string;
  /** What the draft says and who it goes to, as one comparable value. */
  key: string;
}

/** Drafts kept in memory only: enough for one process, and nothing is approved until something is added. */
export function inMemoryApprovedMailDrafts(): ApprovedMailDrafts {
  const kept = new Set<string>();
  const id = (input: ApprovedMailDraft) => JSON.stringify([input.tenant_id, input.created_by, input.key]);
  return {
    has: input => Promise.resolve(kept.has(id(input))),
    add: input => {
      kept.add(id(input));
      return Promise.resolve();
    },
    take: input => Promise.resolve(kept.delete(id(input))),
  };
}

function addressesOf(value: unknown): string[] {
  const items: unknown[] = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return items
    .map(item => {
      const address: unknown = isRecord(item) ? (item['email'] ?? item['address']) : item;
      return typeof address === 'string' ? normalizeMailAddress(address) : JSON.stringify(item);
    })
    .sort();
}

/** Line endings and trailing spaces differ between two writings of the same text, so they are not compared. */
function comparableText(value: unknown): string {
  return typeof value === 'string'
    ? value
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(line => line.trimEnd())
        .join('\n')
        .trim()
    : '';
}

/** An argument left out, and one given as nothing, false or an empty list, say the same thing. */
function saysNothing(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === false ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, stable(value[key])]),
    );
  }
  return value;
}

const COMPARED_APART = new Set(['recipients', 'cc', 'bcc', 'subject', 'body', MAIL_ACCOUNT_ARGUMENT]);

/**
 * One value for the message a draft, a send or a forward writes: the same message gives the same value
 * whichever of the three tools names it. The account is left out, because the card shows it and the
 * person may pick another one there. A forward never matches a new message.
 */
export function mailDraftKey(input: { tool_name: string; params: Record<string, unknown> }): string {
  const { params } = input;
  const rest = Object.keys(params)
    .filter(key => !COMPARED_APART.has(key) && !saysNothing(params[key]))
    .sort()
    .map(key => [key, stable(params[key])]);
  const message = {
    forward: input.tool_name === MAIL_FORWARD_TOOL_NAME,
    to: addressesOf(params['recipients']),
    cc: addressesOf(params['cc']),
    bcc: addressesOf(params['bcc']),
    subject: comparableText(params['subject']),
    body: comparableText(params['body']),
    rest,
  };
  return createHash('sha256').update(JSON.stringify(message)).digest('hex');
}
