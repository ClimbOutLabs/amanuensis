import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { readAccountRecipientLists } from '../../../src/runtime/mailAccountRecipients';
import { readAllowedRecipientsFile } from '../../../src/runtime/mailAllowedRecipients';
import {
  collectSentRecipients,
  fillAccountListsFromSent,
  recipientsOfEmails,
  SENT_MESSAGE_CAP,
  type CallMailTool,
} from '../../../src/runtime/mailFirstFill';

const NOW = new Date('2026-10-21T00:00:00.000Z');
const ACCOUNT = 'owner@example.com';

/** A scripted stub of the sidecar's metadata tool: each call returns the next page in the script. */
function scriptedSent(pages: unknown[][]): { callMailTool: CallMailTool; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const callMailTool: CallMailTool = async (name, args) => {
    expect(name).toBe('list_emails_metadata');
    calls.push(args);
    const emails = pages[calls.length - 1] ?? [];
    return { structuredContent: { emails, page: calls.length, page_size: 100, total: 0 } };
  };
  return { callMailTool, calls };
}

describe('recipientsOfEmails', () => {
  it('keeps exact lowercased addresses in order and drops anything else; duplicates are left for the caller to merge', () => {
    expect(
      recipientsOfEmails([
        { recipients: ['Dana@Example.com', '*@example.com', 'not an address', 42] },
        { recipients: ['dana@example.com', 'sam@example.org'] },
        { no_recipients: true },
      ]),
    ).toEqual(['dana@example.com', 'dana@example.com', 'sam@example.org']);
  });
});

describe('collectSentRecipients', () => {
  it('reads Sent for twelve months, one page at a time, and stops at a short page', async () => {
    const full = Array.from({ length: 100 }, (_, index) => ({ recipients: [`person${index}@example.com`] }));
    const { callMailTool, calls } = scriptedSent([full, [{ recipients: ['last@example.com'] }]]);
    const addresses = await collectSentRecipients({ callMailTool, now: NOW, account_name: ACCOUNT });
    expect(addresses).toHaveLength(101);
    expect(calls.map(call => call['page'])).toEqual([1, 2]);
    expect(calls[0]).toMatchObject({
      account_name: ACCOUNT,
      mailbox: 'Sent',
      page_size: 100,
      order: 'desc',
      since: '2025-10-21T00:00:00.000Z',
    });
  });

  it('reads at most the message cap, however many pages the mailbox has', async () => {
    const page = Array.from({ length: 100 }, (_, index) => ({ recipients: [`p${index}@example.com`] }));
    const pages = Array.from({ length: SENT_MESSAGE_CAP / 100 + 5 }, () => page);
    const { callMailTool, calls } = scriptedSent(pages);
    await collectSentRecipients({ callMailTool, now: NOW, account_name: ACCOUNT });
    expect(calls).toHaveLength(SENT_MESSAGE_CAP / 100);
  });

  it('reads the JSON text of a result when it has no structured content', async () => {
    const callMailTool: CallMailTool = () =>
      Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify({ emails: [{ recipients: ['a@example.com'] }] }) }],
      });
    expect(await collectSentRecipients({ callMailTool, now: NOW, account_name: ACCOUNT })).toEqual(['a@example.com']);
  });

  it('reads an unfamiliar result as no recipients rather than failing open', async () => {
    const callMailTool: CallMailTool = () => Promise.resolve({ content: [{ type: 'text', text: 'not json' }] });
    expect(await collectSentRecipients({ callMailTool, now: NOW, account_name: ACCOUNT })).toEqual([]);
  });
});

describe('fillAccountListsFromSent', () => {
  let dir: string;
  let policyPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mail-fill-'));
    policyPath = join(dir, 'allowed_recipients.toml');
    await writeFile(policyPath, 'db_location = "/data/db.sqlite3"\nallowed_recipients = []\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A stub sidecar with two accounts, each with its own Sent page. */
  function twoAccountSidecar(): CallMailTool {
    const sent: Record<string, unknown[]> = {
      'owner@example.com': [{ recipients: ['Dana@example.com'] }, { recipients: ['dana@example.com'] }],
      'second@example.com': [{ recipients: ['sam@example.org'] }],
    };
    return async (name, args) => {
      if (name === 'list_available_accounts') {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ account_name: 'owner@example.com' }) },
            { type: 'text', text: JSON.stringify({ account_name: 'second@example.com' }) },
          ],
        };
      }
      const account = typeof args['account_name'] === 'string' ? args['account_name'] : '';
      return { structuredContent: { emails: sent[account] ?? [], page: 1, page_size: 100, total: 0 } };
    };
  }

  it('fills each account list from its own Sent, and writes the union for the sidecar', async () => {
    const filled = await fillAccountListsFromSent({ policyPath, callMailTool: twoAccountSidecar(), now: NOW });
    expect(filled).toBe(2);
    const lists = await readAccountRecipientLists({ path: join(dir, 'allowed_recipients_by_account.json') });
    expect(lists.get('owner@example.com')).toEqual(['dana@example.com']);
    expect(lists.get('second@example.com')).toEqual(['sam@example.org']);
    expect(await readAllowedRecipientsFile({ path: policyPath })).toEqual(['dana@example.com', 'sam@example.org']);
  });

  it('leaves a list that is already there alone, and fills only the account that has none', async () => {
    await fillAccountListsFromSent({ policyPath, callMailTool: twoAccountSidecar(), now: NOW });
    const filled = await fillAccountListsFromSent({ policyPath, callMailTool: twoAccountSidecar(), now: NOW });
    expect(filled).toBe(0);
  });

  it('an install with a shared list keeps it under its one account, and fills nothing again', async () => {
    await writeFile(policyPath, 'db_location = "/data/db.sqlite3"\nallowed_recipients = ["old@example.com"]\n');
    const oneAccount: CallMailTool = async name => {
      if (name === 'list_available_accounts') {
        return { content: [{ type: 'text', text: JSON.stringify({ account_name: 'owner@example.com' }) }] };
      }
      throw new Error('Sent must not be read for a seeded account');
    };
    const filled = await fillAccountListsFromSent({ policyPath, callMailTool: oneAccount, now: NOW });
    expect(filled).toBe(0);
    const lists = await readAccountRecipientLists({ path: join(dir, 'allowed_recipients_by_account.json') });
    expect(lists.get('owner@example.com')).toEqual(['old@example.com']);
  });
});
