import { mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  exactRecipientAddress,
  readAllowedRecipientsFile,
  renderAllowedRecipientsFile,
  writeAllowedRecipientsFile,
} from '../../../src/runtime/mailAllowedRecipients';

describe('exactRecipientAddress', () => {
  it('returns the lowercased address for a plain mailbox', () => {
    expect(exactRecipientAddress('  Dana.Lee@Example.COM ')).toBe('dana.lee@example.com');
  });

  it.each([
    ['a wildcard', '*@example.com'],
    ['a glob question mark', 'dana?@example.com'],
    ['an opening bracket', 'dana[1]@example.com'],
    ['a closing bracket', 'dana]@example.com'],
    ['a star in the domain', 'dana@*'],
    ['a bare star', '*'],
    ['a space inside', 'dana lee@example.com'],
    ['a tab', 'dana\t@example.com'],
    ['a missing domain', 'dana@'],
    ['a missing local part', '@example.com'],
    ['no at sign', 'dana.example.com'],
    ['a double quote, which would break the file', 'da"na@example.com'],
    ['a backslash, which would break the file', 'da\\na@example.com'],
    ['an empty value', '   '],
  ])('refuses %s', (_label, raw) => {
    expect(exactRecipientAddress(raw)).toBeNull();
  });
});

describe('renderAllowedRecipientsFile', () => {
  it('writes each validated address once, in the one shape the reader accepts', () => {
    expect(renderAllowedRecipientsFile(['dana@example.com', 'sam@example.com'])).toBe(
      'db_location = "/data/db.sqlite3"\nallowed_recipients = ["dana@example.com", "sam@example.com"]\n',
    );
  });

  it('never writes a wildcard, even when one is passed in', () => {
    expect(() => renderAllowedRecipientsFile(['*'])).toThrow(/not an exact address/);
    expect(() => renderAllowedRecipientsFile(['dana@example.com', '*@example.com'])).toThrow(/not an exact address/);
  });

  it('writes an empty list, which denies every send', () => {
    expect(renderAllowedRecipientsFile([])).toBe('db_location = "/data/db.sqlite3"\nallowed_recipients = []\n');
  });
});

describe('allowed recipients file on disk', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mail-policy-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips an address list and leaves no temporary file behind', async () => {
    const path = join(dir, 'allowed_recipients.toml');
    await writeAllowedRecipientsFile({ path, addresses: ['dana@example.com'] });
    expect(await readAllowedRecipientsFile({ path })).toEqual(['dana@example.com']);
    expect(await readdir(dir)).toEqual(['allowed_recipients.toml']);
  });

  it('reads a missing file as an empty list, so nothing is sendable', async () => {
    expect(await readAllowedRecipientsFile({ path: join(dir, 'absent.toml') })).toEqual([]);
  });

  it('reads a file with a wildcard entry as an empty list, never as allow-all', async () => {
    const path = join(dir, 'allowed_recipients.toml');
    await writeFile(path, 'allowed_recipients = ["*"]\n');
    expect(await readAllowedRecipientsFile({ path })).toEqual([]);
  });

  it('reads a file in any other shape as an empty list', async () => {
    const path = join(dir, 'allowed_recipients.toml');
    await writeFile(path, 'allowed_recipients = ["dana@example.com"]\nallowed_senders = ["*"]\n');
    expect(await readAllowedRecipientsFile({ path })).toEqual([]);
  });

  it('keeps the previous file when a write is refused', async () => {
    const path = join(dir, 'allowed_recipients.toml');
    await writeAllowedRecipientsFile({ path, addresses: ['dana@example.com'] });
    await expect(writeAllowedRecipientsFile({ path, addresses: ['*'] })).rejects.toThrow(/not an exact address/);
    expect(await readAllowedRecipientsFile({ path })).toEqual(['dana@example.com']);
  });
});
