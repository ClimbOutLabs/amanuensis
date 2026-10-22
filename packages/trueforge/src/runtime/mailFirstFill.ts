import { extractErrorLogFields, RemoteMCP } from '@truefoundry/trueforge-core/core';
import { MAIL_CONNECTOR_NAME } from '@truefoundry/trueforge-core/core/email/mailConnector/toolContract';
import type { Logger } from 'winston';

import { addAllowedRecipients, exactRecipientAddress } from './mailAllowedRecipients';

/** The account name the sidecar gives an account supplied by its environment without a name. */
const MAIL_ACCOUNT_NAME = 'default';
const SENT_MAILBOX = 'Sent';
const SENT_LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000;
/** Most sent messages read on the first fill. The list can always grow later from approvals. */
export const SENT_MESSAGE_CAP = 2000;
const PAGE_SIZE = 100;

/** Calls one tool on the Email sidecar and returns its result as the MCP client gives it. */
export type CallMailTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The metadata page's emails, read from the tool's structured result or its JSON text. Anything else reads as none. */
function emailsOfResult(result: unknown): unknown[] {
  if (!isRecord(result)) {
    return [];
  }
  const structured = emailsOf(result['structuredContent']);
  if (structured !== undefined) {
    return structured;
  }
  const content = result['content'];
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text = isRecord(first) ? first['text'] : undefined;
  if (typeof text !== 'string') {
    return [];
  }
  try {
    return emailsOf(JSON.parse(text)) ?? [];
  } catch {
    return [];
  }
}

function emailsOf(value: unknown): unknown[] | undefined {
  const emails = isRecord(value) ? value['emails'] : undefined;
  return Array.isArray(emails) ? emails : undefined;
}

/** The recipients of each message on a page. Each address is checked, so a malformed one is never kept. */
export function recipientsOfEmails(emails: readonly unknown[]): string[] {
  const addresses: string[] = [];
  for (const email of emails) {
    const recipients =
      typeof email === 'object' && email !== null && 'recipients' in email && Array.isArray(email.recipients)
        ? email.recipients
        : [];
    for (const recipient of recipients) {
      if (typeof recipient === 'string') {
        const checked = exactRecipientAddress(recipient);
        if (checked !== null) {
          addresses.push(checked);
        }
      }
    }
  }
  return addresses;
}

/**
 * The exact addresses the owner has sent mail to, read from Sent over the last twelve months, at most
 * SENT_MESSAGE_CAP messages. Each address appears once, lowercased.
 */
export async function collectSentRecipients({
  callMailTool,
  now,
}: {
  callMailTool: CallMailTool;
  now: Date;
}): Promise<string[]> {
  const since = new Date(now.getTime() - SENT_LOOKBACK_MS).toISOString();
  const found = new Set<string>();
  let scanned = 0;
  for (let page = 1; scanned < SENT_MESSAGE_CAP; page += 1) {
    const result = await callMailTool('list_emails_metadata', {
      account_name: MAIL_ACCOUNT_NAME,
      mailbox: SENT_MAILBOX,
      since,
      page,
      page_size: PAGE_SIZE,
      order: 'desc',
    });
    const emails = emailsOfResult(result);
    for (const address of recipientsOfEmails(emails)) {
      found.add(address);
    }
    scanned += emails.length;
    if (emails.length < PAGE_SIZE) {
      break;
    }
  }
  return [...found];
}

/** Adds the addresses the owner has sent mail to. A list that is already there stays, and nothing is removed. */
export async function fillSendListFromSent({
  path,
  callMailTool,
  now,
}: {
  path: string;
  callMailTool: CallMailTool;
  now: Date;
}): Promise<number> {
  const addresses = await collectSentRecipients({ callMailTool, now });
  if (addresses.length > 0) {
    await addAllowedRecipients({ path, addresses });
  }
  return addresses.length;
}

/** Longest one first-fill session may run before it gives up. */
const FIRST_FILL_TIMEOUT_MS = 60_000;

/** The sidecar's tools, through the same remote client a connector uses. Each call is bounded by the timeout. */
export function mailSidecarTools({ url, logger }: { url: string; logger: Logger }): CallMailTool {
  const remote = new RemoteMCP({
    name: MAIL_CONNECTOR_NAME,
    id: MAIL_CONNECTOR_NAME,
    url,
    headers: {},
    logger,
    requestTimeoutMs: FIRST_FILL_TIMEOUT_MS,
    connectTimeoutMs: FIRST_FILL_TIMEOUT_MS,
    signal: AbortSignal.timeout(FIRST_FILL_TIMEOUT_MS),
    refuseRedirects: true,
  });
  return async (name, args) => {
    const response = await remote.callTool({ name, arguments: args });
    if (!('result' in response)) {
      throw new Error('The Email sidecar asked for sign-in, so Sent could not be read.');
    }
    return response.result;
  };
}

const FIRST_FILL_ATTEMPTS = 6;
const FIRST_FILL_RETRY_MS = 10_000;

/**
 * Runs the first fill after the send list was created at boot. The sidecar may still be starting, so a failed
 * attempt is retried a few times. Giving up leaves the list empty: every recipient then asks with a card.
 */
export function runFirstFillInBackground({
  url,
  path,
  logger,
  attempts = FIRST_FILL_ATTEMPTS,
  retryMs = FIRST_FILL_RETRY_MS,
}: {
  url: string;
  path: string;
  logger: Logger;
  attempts?: number;
  retryMs?: number;
}): void {
  void (async () => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const count = await fillSendListFromSent({
          path,
          callMailTool: mailSidecarTools({ url, logger }),
          now: new Date(),
        });
        logger.info('Email send list filled from Sent', { recipients: count });
        return;
      } catch (error) {
        if (attempt === attempts) {
          logger.warn('Email send list could not be filled from Sent; each recipient will ask', {
            ...extractErrorLogFields(error),
          });
          return;
        }
        await new Promise(resolve => setTimeout(resolve, retryMs));
      }
    }
  })();
}
