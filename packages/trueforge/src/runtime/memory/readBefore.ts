/**
 * The questions about the person's words that the model already answered with "nothing worth keeping", so the same
 * words in the same situation are not sent to the model again. Only a fingerprint of each question is kept, never
 * its words. An answer that kept something is not remembered here: it is written for the day it was given and
 * lives in the notes, where the person can change it.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { withVaultLock } from './vaultLock';
import { readVaultStateFile, writeVaultStateFile } from './vaultStateFile';

const READ_BEFORE_FILE = 'read-before.json';

/** The oldest fingerprints beyond this many are dropped; a dropped question is simply asked once more. */
export const MAX_READ_BEFORE = 2000;

const ReadBeforeSchema = z.object({ nothing_to_keep: z.array(z.string()) });
type ReadBefore = z.infer<typeof ReadBeforeSchema>;

function empty(): ReadBefore {
  return { nothing_to_keep: [] };
}

/**
 * What stands for one question: the model asked and every word it was sent. The caller leaves the day out of
 * the messages, because an answer that keeps nothing is the same on any day.
 */
export function questionFingerprint({
  modelFqn,
  messages,
}: {
  modelFqn: string;
  messages: readonly { role: string; content: string }[];
}): string {
  return createHash('sha256')
    .update(JSON.stringify([modelFqn, messages.map(message => [message.role, message.content])]))
    .digest('hex');
}

/** Whether this question was already answered with "nothing worth keeping". A file that cannot be read says no. */
export async function wasReadBefore({
  vaultDir,
  fingerprint,
}: {
  vaultDir: string;
  fingerprint: string;
}): Promise<boolean> {
  const stored = await readVaultStateFile({ vaultDir, name: READ_BEFORE_FILE, schema: ReadBeforeSchema, empty });
  return stored.nothing_to_keep.includes(fingerprint);
}

/** Records that this question was answered with "nothing worth keeping". */
export async function noteReadBefore({
  vaultDir,
  fingerprint,
}: {
  vaultDir: string;
  fingerprint: string;
}): Promise<void> {
  await withVaultLock({ vaultDir }, async () => {
    const stored = await readVaultStateFile({ vaultDir, name: READ_BEFORE_FILE, schema: ReadBeforeSchema, empty });
    if (stored.nothing_to_keep.includes(fingerprint)) {
      return;
    }
    await writeVaultStateFile({
      vaultDir,
      name: READ_BEFORE_FILE,
      value: { nothing_to_keep: [...stored.nothing_to_keep, fingerprint].slice(-MAX_READ_BEFORE) },
    });
  });
}
