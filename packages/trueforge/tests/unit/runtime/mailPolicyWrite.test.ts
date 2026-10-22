import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  addAllowedRecipients,
  allowedRecipientsFileHash,
  ensureAllowedRecipientsFile,
  readAllowedRecipientsFile,
  waitForSidecarLoadedHash,
} from '../../../src/runtime/mailAllowedRecipients';

describe('send list writes', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mail-policy-'));
    path = join(dir, 'allowed_recipients.toml');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('adds new addresses, keeps the ones already there, and never lists one twice', async () => {
    await addAllowedRecipients({ path, addresses: ['dana@example.com'] });
    await addAllowedRecipients({ path, addresses: ['Sam@Example.com', 'dana@example.com'] });
    expect(await readAllowedRecipientsFile({ path })).toEqual(['dana@example.com', 'sam@example.com']);
  });

  it('returns the hash of the bytes it wrote, which the sidecar records for the same bytes', async () => {
    const hash = await addAllowedRecipients({ path, addresses: ['dana@example.com'] });
    expect(hash).toBe(allowedRecipientsFileHash(await readFile(path, 'utf8')));
  });

  it.each([
    ['a wildcard', '*@example.com'],
    ['a question mark', 'dana?@example.com'],
    ['a space', 'dana @example.com'],
    ['no domain', 'dana'],
  ])('refuses %s and writes nothing at all', async (_label, address) => {
    await expect(addAllowedRecipients({ path, addresses: ['dana@example.com', address] })).rejects.toThrow(
      /not an exact address/,
    );
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });

  it('creates an empty list once, and leaves an existing list alone after that', async () => {
    expect(await ensureAllowedRecipientsFile({ path })).toBe(true);
    await addAllowedRecipients({ path, addresses: ['dana@example.com'] });
    expect(await ensureAllowedRecipientsFile({ path })).toBe(false);
    expect(await readAllowedRecipientsFile({ path })).toEqual(['dana@example.com']);
  });

  it('leaves no temporary file behind after a refused write', async () => {
    await writeFile(path, 'db_location = "/data/db.sqlite3"\nallowed_recipients = []\n');
    await expect(addAllowedRecipients({ path, addresses: ['*'] })).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['allowed_recipients.toml']);
  });
});

describe('waitForSidecarLoadedHash', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mail-status-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns true once the sidecar has recorded the hash', async () => {
    const statusPath = join(dir, 'loaded.sha256');
    setTimeout(() => {
      void writeFile(statusPath, 'abc123\n');
    }, 20);
    await expect(waitForSidecarLoadedHash({ statusPath, hash: 'abc123', timeoutMs: 2000, pollMs: 5 })).resolves.toBe(
      true,
    );
  });

  it('returns false on timeout when another hash is recorded', async () => {
    const statusPath = join(dir, 'loaded.sha256');
    await writeFile(statusPath, 'old\n');
    await expect(waitForSidecarLoadedHash({ statusPath, hash: 'new', timeoutMs: 50, pollMs: 5 })).resolves.toBe(false);
  });

  it('returns false on timeout when the sidecar has not written a status at all', async () => {
    await expect(
      waitForSidecarLoadedHash({ statusPath: join(dir, 'missing'), hash: 'new', timeoutMs: 30, pollMs: 5 }),
    ).resolves.toBe(false);
  });
});
