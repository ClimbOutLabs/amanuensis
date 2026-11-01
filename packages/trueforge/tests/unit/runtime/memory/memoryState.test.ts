import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  readVaultTimeZone,
  recordVaultTimeZone,
  VAULT_TIMEZONE_FILE,
} from '../../../../src/runtime/memory/memoryState';

async function makeVault(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'memory-state-'));
}

describe('vault time zone', () => {
  it('reads nothing from a fresh vault', async () => {
    expect(await readVaultTimeZone(await makeVault())).toBeUndefined();
  });

  it('records a zone, with a README beside it, and reads it back', async () => {
    const vaultDir = await makeVault();
    await recordVaultTimeZone({ vaultDir, timeZone: 'Europe/Madrid' });
    expect(await readVaultTimeZone(vaultDir)).toBe('Europe/Madrid');
    expect(await readFile(path.join(vaultDir, VAULT_TIMEZONE_FILE), 'utf8')).toBe('Europe/Madrid\n');
    expect((await readFile(path.join(vaultDir, '.memory-state', 'README'), 'utf8')).toLowerCase()).toContain(
      'time zone',
    );
    expect((await readdir(path.join(vaultDir, '.memory-state'))).some(name => name.includes('tmp'))).toBe(false);
  });

  it('replaces the zone when it changes and leaves the file alone when it does not', async () => {
    const vaultDir = await makeVault();
    await recordVaultTimeZone({ vaultDir, timeZone: 'Europe/Madrid' });
    const before = await stat(path.join(vaultDir, VAULT_TIMEZONE_FILE));
    await new Promise(resolve => setTimeout(resolve, 20));
    await recordVaultTimeZone({ vaultDir, timeZone: 'Europe/Madrid' });
    expect((await stat(path.join(vaultDir, VAULT_TIMEZONE_FILE))).mtimeMs).toBe(before.mtimeMs);
    await recordVaultTimeZone({ vaultDir, timeZone: 'America/New_York' });
    expect(await readVaultTimeZone(vaultDir)).toBe('America/New_York');
  });

  it('ignores a name that is not a time zone, on write and on read', async () => {
    const vaultDir = await makeVault();
    await recordVaultTimeZone({ vaultDir, timeZone: 'Not/AZone' });
    expect(await readVaultTimeZone(vaultDir)).toBeUndefined();
    await recordVaultTimeZone({ vaultDir, timeZone: 'UTC' });
    expect(await readVaultTimeZone(vaultDir)).toBe('UTC');
  });

  it('never throws when the vault cannot be written', async () => {
    await expect(recordVaultTimeZone({ vaultDir: '/dev/null/nope', timeZone: 'UTC' })).resolves.toBeUndefined();
  });
});
