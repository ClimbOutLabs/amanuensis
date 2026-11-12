import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SqliteGlobalSettingsStore } from '../../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { FileKeyProvider, encodeKeyFile } from '../../../../src/secrets/fileKeyProvider';
import { createMasterKey, recordKeyCheck } from '../../../../src/secrets/keyCheck';
import { watchForKey } from '../../../../src/secrets/keyWatch';
import { SecretVault, type SecretVaultState } from '../../../../src/secrets/secretVault';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (check()) {
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        reject(new Error('Timed out waiting'));
      } else {
        setTimeout(poll, 5);
      }
    };
    poll();
  });
}

describe('watchForKey', () => {
  let env: SqliteTestDatabase;
  let dir: string;
  let keyFile: string;
  const stops: Array<() => void> = [];

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    dir = await mkdtemp(path.join(tmpdir(), 'aman-watch-'));
    keyFile = path.join(dir, 'master.key');
  }, 120_000);

  afterEach(async () => {
    stops.splice(0).forEach(stop => {
      stop();
    });
    await rm(dir, { recursive: true, force: true });
    await env?.teardown();
  });

  function watch(vault: SecretVault, timing: { fastForMs: number; nowMs?: () => number }): SecretVaultState[] {
    const seen: SecretVaultState[] = [];
    stops.push(
      watchForKey({
        vault,
        onChange: state => seen.push(state),
        fastMs: 10,
        slowMs: 40,
        fastForMs: timing.fastForMs,
        ...(timing.nowMs === undefined ? {} : { now: timing.nowMs }),
      }),
    );
    return seen;
  }

  it('unlocks by itself when the key arrives after start, with no restart', async () => {
    const settings = new SqliteGlobalSettingsStore(env.db);
    const key = createMasterKey();
    await recordKeyCheck({ settings, key });
    const vault = new SecretVault({ provider: new FileKeyProvider(keyFile), settings });
    const seen = watch(vault, { fastForMs: 60_000 });

    await waitFor(() => seen.length === 1);
    expect(seen[0]).toMatchObject({ status: 'locked', reason: 'no_key' });

    await writeFile(keyFile, encodeKeyFile(key), { mode: 0o600 });
    await waitFor(() => vault.state.status === 'unlocked');
    expect(seen.map(state => state.status)).toEqual(['locked', 'unlocked']);
  });

  it('keeps checking at the slow pace once the fast window is over', async () => {
    const settings = new SqliteGlobalSettingsStore(env.db);
    const key = createMasterKey();
    await recordKeyCheck({ settings, key });
    const vault = new SecretVault({ provider: new FileKeyProvider(keyFile), settings });
    // The clock says the fast window has already passed.
    let clock = 0;
    const seen = watch(vault, {
      fastForMs: 1,
      nowMs: () => {
        clock += 1_000;
        return clock;
      },
    });
    await waitFor(() => seen.length === 1);

    await writeFile(keyFile, encodeKeyFile(key), { mode: 0o600 });
    await waitFor(() => vault.state.status === 'unlocked');
  });

  it('reports a wrong key once and unlocks when the right key replaces it', async () => {
    const settings = new SqliteGlobalSettingsStore(env.db);
    const key = createMasterKey();
    await recordKeyCheck({ settings, key });
    await writeFile(keyFile, encodeKeyFile(createMasterKey()), { mode: 0o600 });
    const vault = new SecretVault({ provider: new FileKeyProvider(keyFile), settings });
    const seen = watch(vault, { fastForMs: 60_000 });

    await waitFor(() => seen.length === 1);
    expect(seen[0]).toMatchObject({ status: 'locked', reason: 'wrong_key' });
    // Several more checks go by without repeating the report.
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(seen).toHaveLength(1);

    await writeFile(keyFile, encodeKeyFile(key), { mode: 0o600 });
    await waitFor(() => vault.state.status === 'unlocked');
    expect(seen).toHaveLength(2);
  });

  it('stops checking when stopped', async () => {
    const settings = new SqliteGlobalSettingsStore(env.db);
    const key = createMasterKey();
    await recordKeyCheck({ settings, key });
    const vault = new SecretVault({ provider: new FileKeyProvider(keyFile), settings });
    const seen = watch(vault, { fastForMs: 60_000 });
    await waitFor(() => seen.length === 1);
    stops.splice(0).forEach(stop => {
      stop();
    });
    await new Promise(resolve => setTimeout(resolve, 30));

    await writeFile(keyFile, encodeKeyFile(key), { mode: 0o600 });
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(vault.state.status).toBe('locked');
  });
});
