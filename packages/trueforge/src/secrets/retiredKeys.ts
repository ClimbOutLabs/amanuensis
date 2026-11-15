import { z } from 'zod';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import { KEY_CHECK_SETTING, checkMasterKey, keyCheckValue } from './keyCheck';
import { RECOVERY_COPY_SETTING, openRecoveryCopy, recoverMasterKey, saveRecoveryCopy } from './recoveryKey';
import { MASTER_KEY_BYTES, decryptSecret, encryptSecret, masterKeyId, type SecretContext } from './secretCipher';

/**
 * Global setting that holds the keys this database's secrets were encrypted with before it moved
 * to this computer, each one encrypted with this computer's key.
 */
export const RETIRED_KEYS_SETTING = 'secrets_retired_keys';

const RetiredKeysSchema = z.object({
  keys: z.array(z.object({ key_id: z.string().min(1), wrapped: z.string().min(1) })),
});

function retiredKeyContext(keyId: string): SecretContext {
  return { table: 'global_settings', primary_key: RETIRED_KEYS_SETTING, field: keyId };
}

/** The earlier keys of this database by key id, opened with its current master key. */
export async function loadRetiredKeys({
  settings,
  masterKey,
}: {
  settings: IGlobalSettingsStore;
  masterKey: Buffer;
}): Promise<Map<string, Buffer>> {
  const saved = await settings.getSetting({ key: RETIRED_KEYS_SETTING });
  const keys = new Map<string, Buffer>();
  if (saved === undefined) {
    return keys;
  }
  for (const entry of RetiredKeysSchema.parse(JSON.parse(saved.value)).keys) {
    const key = Buffer.from(
      decryptSecret({ key: masterKey, value: entry.wrapped, context: retiredKeyContext(entry.key_id) }),
      'base64',
    );
    if (key.length === MASTER_KEY_BYTES) {
      keys.set(entry.key_id, key);
    }
  }
  return keys;
}

/**
 * Ties a database that came from another computer to this computer's key, using its recovery key.
 * Nothing is encrypted again: the earlier key is kept, encrypted with this computer's key, so
 * secrets saved before the move still open, and everything saved from now on uses the new key.
 * The same recovery key keeps working. Safe to run again after a run that stopped part way.
 */
export async function adoptDatabase({
  settings,
  masterKey,
  recoveryKey,
  moveDatabase,
}: {
  settings: IGlobalSettingsStore;
  masterKey: Buffer;
  recoveryKey: string;
  /** Moves the stored data itself from the earlier key to `masterKey`, before the records say it has moved. */
  moveDatabase: (earlierKey: Buffer) => Promise<void>;
}): Promise<'adopted' | 'already_adopted'> {
  const state = await checkMasterKey({ settings, key: masterKey });
  if (state === 'not_set_up') {
    throw new Error('This database has no key yet, so there is nothing to move. Run "aman secrets init" instead.');
  }
  if (state === 'match') {
    // A run that stopped after the key check was replaced left the recovery copy on the earlier key.
    await repairRecoveryCopy({ settings, masterKey, recoveryKey });
    return 'already_adopted';
  }
  const earlierKey = await recoverMasterKey({ settings, recoveryKey });
  await moveDatabase(earlierKey);
  const retired = await loadRetiredKeys({ settings, masterKey: earlierKey });
  retired.set(masterKeyId(earlierKey).toString('hex'), earlierKey);
  const keys = [...retired.entries()].map(([keyId, key]) => ({
    key_id: keyId,
    wrapped: encryptSecret({ key: masterKey, plaintext: key.toString('base64'), context: retiredKeyContext(keyId) }),
  }));
  await settings.setSetting({ key: RETIRED_KEYS_SETTING, value: JSON.stringify({ keys }) });
  await settings.setSetting({ key: KEY_CHECK_SETTING, value: keyCheckValue(masterKey) });
  await saveRecoveryCopy({ settings, masterKey, recoveryKey });
  return 'adopted';
}

async function repairRecoveryCopy({
  settings,
  masterKey,
  recoveryKey,
}: {
  settings: IGlobalSettingsStore;
  masterKey: Buffer;
  recoveryKey: string;
}): Promise<void> {
  const copy = await settings.getSetting({ key: RECOVERY_COPY_SETTING });
  // A wrong recovery key is refused here, so it can never replace the copy that the right one opens.
  const held = copy === undefined ? undefined : openRecoveryCopy({ copy: copy.value, recoveryKey });
  if (!held?.equals(masterKey)) {
    await saveRecoveryCopy({ settings, masterKey, recoveryKey });
  }
}
