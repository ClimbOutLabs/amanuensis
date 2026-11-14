import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import { FileKeyProvider } from './fileKeyProvider';
import { SecretVault } from './secretVault';

const REASONS = {
  no_key: "This computer's key is not available",
  not_set_up: 'This instance is not set up to keep saved logins encrypted yet',
  wrong_key: "This computer's key does not match this instance's data",
} as const;

/**
 * The unlocked vault for a one-off command, which cannot wait for a key the way the server does.
 * Throws with the one thing to do next when the key is missing or is not this instance's key.
 */
export async function openCommandVault({
  settings,
  keyFile,
}: {
  settings: IGlobalSettingsStore;
  keyFile: string;
}): Promise<SecretVault> {
  const vault = new SecretVault({ provider: new FileKeyProvider(keyFile), settings });
  const state = await vault.refresh();
  if (state.status !== 'unlocked') {
    throw new Error(`${REASONS[state.reason]} (${state.detail}). Run "aman doctor" to see how to fix it.`);
  }
  return vault;
}

/**
 * The vault for a command that only reads. It may still be locked, so a database from before
 * encryption can be read with no key; reading an encrypted login while locked throws.
 */
export async function openReadingVault({
  settings,
  keyFile,
}: {
  settings: IGlobalSettingsStore;
  keyFile: string;
}): Promise<SecretVault> {
  const vault = new SecretVault({ provider: new FileKeyProvider(keyFile), settings });
  await vault.refresh();
  return vault;
}
