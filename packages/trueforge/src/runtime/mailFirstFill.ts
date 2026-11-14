import { extractErrorLogFields, RemoteMCP } from '@truefoundry/trueforge-core/core';
import {
  accountNamesOfResult,
  emailsOfResult,
} from '@truefoundry/trueforge-core/core/email/mailConnector/mailToolResults';
import { MAIL_CONNECTOR_NAME } from '@truefoundry/trueforge-core/core/email/mailConnector/toolContract';
import type { Logger } from 'winston';

import {
  accountRecipientListsPath,
  readAccountRecipientLists,
  seedAccountListsFromSidecarList,
  syncSidecarListFromAccountLists,
  writeAccountRecipientLists,
} from './mailAccountRecipients';
import { exactRecipientAddress } from './mailAllowedRecipients';

const SENT_MAILBOX = 'Sent';
const SENT_LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000;
/** Most sent messages read on the first fill. The list can always grow later from approvals. */
export const SENT_MESSAGE_CAP = 2000;
const PAGE_SIZE = 100;

/** Calls one tool on the Email sidecar and returns its result as the MCP client gives it. */
export type CallMailTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

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
 * The exact addresses the owner has sent mail to from one account, read from its Sent over the last
 * twelve months, at most SENT_MESSAGE_CAP messages. Each address appears once, lowercased.
 */
export async function collectSentRecipients({
  callMailTool,
  now,
  account_name,
}: {
  callMailTool: CallMailTool;
  now: Date;
  /** The account whose Sent is read; the sidecar names an account by its address. */
  account_name: string;
}): Promise<string[]> {
  const since = new Date(now.getTime() - SENT_LOOKBACK_MS).toISOString();
  const found = new Set<string>();
  let scanned = 0;
  for (let page = 1; scanned < SENT_MESSAGE_CAP; page += 1) {
    const result = await callMailTool('list_emails_metadata', {
      account_name,
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

/** The account names the sidecar reports, in its own order. */
export async function readSidecarAccountNames(callMailTool: CallMailTool): Promise<string[]> {
  const result = await callMailTool('list_available_accounts', {});
  return accountNamesOfResult(result);
}

/**
 * Fills the send list of every connected account that has none yet, from that account's own Sent.
 * A list that is already there stays, and nothing is removed. An install moving from the one shared
 * list is seeded first, so its history stays with the account it was approved under. When any list
 * was filled, the sidecar's shared list is rewritten as the union of the accounts' lists. Returns
 * how many accounts were filled.
 */
export async function fillAccountListsFromSent({
  policyPath,
  callMailTool,
  now,
}: {
  policyPath: string;
  callMailTool: CallMailTool;
  now: Date;
}): Promise<number> {
  const listsPath = accountRecipientListsPath(policyPath);
  const names = await readSidecarAccountNames(callMailTool);
  await seedAccountListsFromSidecarList({ policyPath, listsPath, accounts: names });
  const lists = await readAccountRecipientLists({ path: listsPath });
  let filled = 0;
  for (const name of names) {
    const account = exactRecipientAddress(name);
    if (account === null || lists.has(account)) {
      continue;
    }
    const addresses = await collectSentRecipients({ callMailTool, now, account_name: name });
    lists.set(account, addresses);
    filled += 1;
  }
  if (filled > 0) {
    await writeAccountRecipientLists({ path: listsPath, lists });
    await syncSidecarListFromAccountLists({ policyPath, listsPath });
  }
  return filled;
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
 * Runs the first fill for any account that has no send list yet. The sidecar may still be starting, so a
 * failed attempt is retried a few times. Giving up leaves the lists empty: every recipient then asks
 * with a card.
 */
export function runAccountListFillInBackground({
  url,
  policyPath,
  logger,
  attempts = FIRST_FILL_ATTEMPTS,
  retryMs = FIRST_FILL_RETRY_MS,
}: {
  url: string;
  policyPath: string;
  logger: Logger;
  attempts?: number;
  retryMs?: number;
}): void {
  void (async () => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const filled = await fillAccountListsFromSent({
          policyPath,
          callMailTool: mailSidecarTools({ url, logger }),
          now: new Date(),
        });
        if (filled > 0) {
          logger.info('Email send lists filled from Sent', { accounts: filled });
        }
        return;
      } catch (error) {
        if (attempt === attempts) {
          logger.warn('Email send lists could not be filled from Sent; each recipient will ask', {
            ...extractErrorLogFields(error),
          });
          return;
        }
        await new Promise(resolve => setTimeout(resolve, retryMs));
      }
    }
  })();
}
