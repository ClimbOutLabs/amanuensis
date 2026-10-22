import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { readAllowedRecipientsFile } from '../../../src/runtime/mailAllowedRecipients';
import {
  collectSentRecipients,
  fillSendListFromSent,
  recipientsOfEmails,
  SENT_MESSAGE_CAP,
  type CallMailTool,
} from '../../../src/runtime/mailFirstFill';

const NOW = new Date('2026-10-21T00:00:00.000Z');

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
    const addresses = await collectSentRecipients({ callMailTool, now: NOW });
    expect(addresses).toHaveLength(101);
    expect(calls.map(call => call['page'])).toEqual([1, 2]);
    expect(calls[0]).toMatchObject({
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
    await collectSentRecipients({ callMailTool, now: NOW });
    expect(calls).toHaveLength(SENT_MESSAGE_CAP / 100);
  });

  it('reads the JSON text of a result when it has no structured content', async () => {
    const callMailTool: CallMailTool = () =>
      Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify({ emails: [{ recipients: ['a@example.com'] }] }) }],
      });
    expect(await collectSentRecipients({ callMailTool, now: NOW })).toEqual(['a@example.com']);
  });

  it('reads an unfamiliar result as no recipients rather than failing open', async () => {
    const callMailTool: CallMailTool = () => Promise.resolve({ content: [{ type: 'text', text: 'not json' }] });
    expect(await collectSentRecipients({ callMailTool, now: NOW })).toEqual([]);
  });
});

describe('fillSendListFromSent', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mail-fill-'));
    path = join(dir, 'allowed_recipients.toml');
    await writeFile(path, 'db_location = "/data/db.sqlite3"\nallowed_recipients = []\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the addresses it found into the send list, once each', async () => {
    const { callMailTool } = scriptedSent([
      [{ recipients: ['Dana@example.com'] }, { recipients: ['dana@example.com'] }],
    ]);
    expect(await fillSendListFromSent({ path, callMailTool, now: NOW })).toBe(1);
    expect(await readAllowedRecipientsFile({ path })).toEqual(['dana@example.com']);
  });

  it('leaves the list as it was when Sent has no addresses', async () => {
    const { callMailTool } = scriptedSent([[]]);
    expect(await fillSendListFromSent({ path, callMailTool, now: NOW })).toBe(0);
    expect(await readAllowedRecipientsFile({ path })).toEqual([]);
  });
});
