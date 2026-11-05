import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FileKeyProvider, decodeKeyFile, encodeKeyFile } from '../../../src/secrets/fileKeyProvider';
import { createMasterKey } from '../../../src/secrets/keyCheck';

describe('FileKeyProvider', () => {
  let dir: string;
  let keyFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aman-key-'));
    keyFile = path.join(dir, 'master.key');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads a valid key file', async () => {
    const key = createMasterKey();
    await writeFile(keyFile, encodeKeyFile(key), { mode: 0o600 });
    const loaded = await new FileKeyProvider(keyFile).load();
    expect(loaded.status).toBe('loaded');
    expect(loaded.status === 'loaded' && loaded.key.equals(key)).toBe(true);
  });

  it('waits for a key that has not been delivered yet', async () => {
    expect(await new FileKeyProvider(keyFile).load()).toEqual({
      status: 'unavailable',
      reason: 'The key has not been delivered yet',
    });
  });

  it('refuses a key file other accounts can read', async () => {
    await writeFile(keyFile, encodeKeyFile(createMasterKey()), { mode: 0o600 });
    await chmod(keyFile, 0o644);
    const loaded = await new FileKeyProvider(keyFile).load();
    expect(loaded).toMatchObject({ status: 'unavailable' });
    expect(loaded.status === 'unavailable' && loaded.reason).toContain('Other accounts');
  });

  it.each([
    ['too short', Buffer.alloc(16, 1).toString('base64')],
    ['not base64', 'not a key at all'],
    ['empty', ''],
  ])('refuses a key file that is %s', async (_label, text) => {
    await writeFile(keyFile, text, { mode: 0o600 });
    expect(await new FileKeyProvider(keyFile).load()).toEqual({
      status: 'unavailable',
      reason: 'The key file is not a valid key',
    });
  });

  it('never puts key bytes in its reasons', async () => {
    const key = createMasterKey();
    await writeFile(keyFile, encodeKeyFile(key), { mode: 0o644 });
    const loaded = await new FileKeyProvider(keyFile).load();
    expect(JSON.stringify(loaded)).not.toContain(key.toString('base64'));
  });
});

describe('key file format', () => {
  it('round-trips a key and tolerates surrounding whitespace', () => {
    const key = createMasterKey();
    expect(decodeKeyFile(`  ${encodeKeyFile(key)}\n`)?.equals(key)).toBe(true);
  });
});
