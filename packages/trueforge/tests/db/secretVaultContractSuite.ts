/**
 * Behavioural contract for SecretVault against a real settings store.
 * Runs under jest against a fresh database per test (see backend test files).
 */
import { randomBytes } from 'node:crypto';

import type { IGlobalSettingsStore } from '../../src/db/globalSettingsStore';
import {
  KEY_CHECK_SETTING,
  SecretsAlreadySetUpError,
  createMasterKey,
  recordKeyCheck,
} from '../../src/secrets/keyCheck';
import type { KeyLoadResult, KeyProvider } from '../../src/secrets/keyProvider';
import {
  RECOVERY_COPY_SETTING,
  RecoveryCopyMissingError,
  RecoveryKeyRejectedError,
  generateRecoveryKey,
  recoverMasterKey,
  saveRecoveryCopy,
} from '../../src/secrets/recoveryKey';
import type { SecretContext } from '../../src/secrets/secretCipher';
import { SecretVault, SecretsLockedError } from '../../src/secrets/secretVault';

const context: SecretContext = { table: 'global_settings', primary_key: 'test_secret', field: 'value' };

/** A host key slot the test can fill or empty. */
export class TestKeyProvider implements KeyProvider {
  key: Buffer | undefined;
  loads = 0;

  constructor(key?: Buffer) {
    this.key = key;
  }

  load(): Promise<KeyLoadResult> {
    this.loads += 1;
    return Promise.resolve(
      this.key === undefined
        ? { status: 'unavailable', reason: 'No key delivered' }
        : { status: 'loaded', key: this.key },
    );
  }
}

export function runSecretVaultContractSuite(getSettings: () => IGlobalSettingsStore): void {
  it('stays locked as "not set up" when the database has no key check value', async () => {
    const vault = new SecretVault({ provider: new TestKeyProvider(createMasterKey()), settings: getSettings() });
    expect(await vault.refresh()).toMatchObject({ status: 'locked', reason: 'not_set_up' });
    expect(() => vault.encrypt({ plaintext: 'x', context })).toThrow(SecretsLockedError);
  });

  it('never creates a key or a check value while starting', async () => {
    const settings = getSettings();
    const provider = new TestKeyProvider();
    const vault = new SecretVault({ provider, settings });
    await vault.refresh();
    await vault.refresh();
    expect(await settings.getSetting({ key: KEY_CHECK_SETTING })).toBeUndefined();
    expect(provider.key).toBeUndefined();
  });

  it('unlocks with the key that setup recorded and round-trips a secret', async () => {
    const settings = getSettings();
    const key = createMasterKey();
    await recordKeyCheck({ settings, key });
    const vault = new SecretVault({ provider: new TestKeyProvider(key), settings });
    expect(await vault.refresh()).toEqual({ status: 'unlocked' });
    const value = vault.encrypt({ plaintext: 'oauth-refresh-canary', context });
    expect(vault.decrypt({ value, context })).toBe('oauth-refresh-canary');
  });

  it('locks as "wrong key" for a key that does not match this database', async () => {
    const settings = getSettings();
    await recordKeyCheck({ settings, key: createMasterKey() });
    const vault = new SecretVault({ provider: new TestKeyProvider(randomBytes(32)), settings });
    expect(await vault.refresh()).toMatchObject({ status: 'locked', reason: 'wrong_key' });
    expect(() => vault.decrypt({ value: 'enc:v1:AAAA', context })).toThrow(SecretsLockedError);
  });

  it('locks as "no key" until the host delivers it, then unlocks on the next check', async () => {
    const settings = getSettings();
    const key = createMasterKey();
    await recordKeyCheck({ settings, key });
    const provider = new TestKeyProvider();
    const vault = new SecretVault({ provider, settings });
    expect(await vault.refresh()).toMatchObject({ status: 'locked', reason: 'no_key' });
    provider.key = key;
    expect(await vault.refresh()).toEqual({ status: 'unlocked' });
  });

  it('refuses to record a second key check value', async () => {
    const settings = getSettings();
    const first = createMasterKey();
    await recordKeyCheck({ settings, key: first });
    await expect(recordKeyCheck({ settings, key: createMasterKey() })).rejects.toBeInstanceOf(SecretsAlreadySetUpError);
    const vault = new SecretVault({ provider: new TestKeyProvider(first), settings });
    expect(await vault.refresh()).toEqual({ status: 'unlocked' });
  });

  it('decrypts a value saved in a settings row after it is read back', async () => {
    const settings = getSettings();
    const key = createMasterKey();
    await recordKeyCheck({ settings, key });
    const vault = new SecretVault({ provider: new TestKeyProvider(key), settings });
    await vault.refresh();
    await settings.setSetting({ key: 'test_secret', value: vault.encrypt({ plaintext: 'stored-canary', context }) });
    const row = await settings.getSetting({ key: 'test_secret' });
    expect(row?.value).not.toContain('stored-canary');
    expect(vault.decrypt({ value: row?.value ?? '', context })).toBe('stored-canary');
  });

  it('restores with the recovery key alone on a machine with no key', async () => {
    const settings = getSettings();
    const key = createMasterKey();
    await recordKeyCheck({ settings, key });
    const recoveryKey = generateRecoveryKey();
    await saveRecoveryCopy({ settings, masterKey: key, recoveryKey });
    const vault = new SecretVault({ provider: new TestKeyProvider(), settings });
    expect(await vault.refresh()).toMatchObject({ status: 'locked', reason: 'no_key' });
    // Typed with spaces instead of dashes, as a person reading it off paper might.
    const recovered = await vault.unlockWithRecoveryKey(recoveryKey.replace(/-/g, ' '));
    expect(recovered.equals(key)).toBe(true);
    expect(vault.state).toEqual({ status: 'unlocked' });
    const value = vault.encrypt({ plaintext: 'after-restore', context });
    expect(vault.decrypt({ value, context })).toBe('after-restore');
  });

  it('rejects a wrong recovery key and stays locked', async () => {
    const settings = getSettings();
    const key = createMasterKey();
    await recordKeyCheck({ settings, key });
    await saveRecoveryCopy({ settings, masterKey: key, recoveryKey: generateRecoveryKey() });
    const vault = new SecretVault({ provider: new TestKeyProvider(), settings });
    await vault.refresh();
    await expect(vault.unlockWithRecoveryKey(generateRecoveryKey())).rejects.toBeInstanceOf(RecoveryKeyRejectedError);
    expect(vault.state).toMatchObject({ status: 'locked' });
  });

  it('makes the old recovery key stop working when a new one is saved', async () => {
    const settings = getSettings();
    const key = createMasterKey();
    await recordKeyCheck({ settings, key });
    const oldKey = generateRecoveryKey();
    const newKey = generateRecoveryKey();
    await saveRecoveryCopy({ settings, masterKey: key, recoveryKey: oldKey });
    await saveRecoveryCopy({ settings, masterKey: key, recoveryKey: newKey });
    await expect(recoverMasterKey({ settings, recoveryKey: oldKey })).rejects.toBeInstanceOf(RecoveryKeyRejectedError);
    expect((await recoverMasterKey({ settings, recoveryKey: newKey })).equals(key)).toBe(true);
  });

  it('refuses to save a recovery copy for a key this database was not set up with', async () => {
    const settings = getSettings();
    await recordKeyCheck({ settings, key: createMasterKey() });
    await expect(
      saveRecoveryCopy({ settings, masterKey: createMasterKey(), recoveryKey: generateRecoveryKey() }),
    ).rejects.toThrow('Set up secrets');
    expect(await settings.getSetting({ key: RECOVERY_COPY_SETTING })).toBeUndefined();
  });

  it('says plainly when there is no recovery copy to restore from', async () => {
    const settings = getSettings();
    await recordKeyCheck({ settings, key: createMasterKey() });
    await expect(recoverMasterKey({ settings, recoveryKey: generateRecoveryKey() })).rejects.toBeInstanceOf(
      RecoveryCopyMissingError,
    );
  });

  it('keeps the master key and recovery key out of the stored copy', async () => {
    const settings = getSettings();
    const key = createMasterKey();
    await recordKeyCheck({ settings, key });
    const recoveryKey = generateRecoveryKey();
    await saveRecoveryCopy({ settings, masterKey: key, recoveryKey });
    const stored = (await settings.getSetting({ key: RECOVERY_COPY_SETTING }))?.value ?? '';
    expect(stored).not.toContain(key.toString('base64'));
    expect(stored).not.toContain(recoveryKey.replace(/-/g, ''));
  });
}
