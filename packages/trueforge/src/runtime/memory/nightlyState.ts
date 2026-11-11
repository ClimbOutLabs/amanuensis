/**
 * What the nightly job remembers about one vault: the last day it ran, which pages it has already looked at, and
 * how often a missed note failed to sort. The day is checked and written under the vault lock, so with two server
 * processes only one runs the job for a vault on a given day.
 */
import { z } from 'zod';

import { withVaultLock } from './vaultLock';
import { readVaultStateFile, writeVaultStateFile } from './vaultStateFile';

const NIGHTLY_STATE_FILE = 'nightly.json';

/** How long the day check waits for a busy vault; the job tries again at its next look. */
const DAY_CLAIM_WAIT_MS = 3000;

const NightlyStateSchema = z.strictObject({
  last_run_day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** `kind/slug` of a page to a fingerprint of the page as the disagreement step last looked at it. */
  looked_at: z.record(z.string(), z.string()),
  /** Note id to how many nights sorting it failed. */
  note_tries: z.record(z.string(), z.number().int().min(0)),
});
export type NightlyState = z.infer<typeof NightlyStateSchema>;

function emptyState(): NightlyState {
  return { looked_at: {}, note_tries: {} };
}

export function readNightlyState(vaultDir: string): Promise<NightlyState> {
  return readVaultStateFile({ vaultDir, name: NIGHTLY_STATE_FILE, schema: NightlyStateSchema, empty: emptyState });
}

/** Changes the state under the vault lock. The lock is held for the read and the write only. */
export async function changeNightlyState({
  vaultDir,
  change,
}: {
  vaultDir: string;
  change: (state: NightlyState) => NightlyState;
}): Promise<void> {
  await withVaultLock({ vaultDir }, async () => {
    await writeVaultStateFile({ vaultDir, name: NIGHTLY_STATE_FILE, value: change(await readNightlyState(vaultDir)) });
  });
}

/**
 * Takes today for this vault. False when the job already ran or started today. Throws `VaultBusyError` when the
 * vault stays busy, and then the day is not taken.
 */
export async function claimNightlyDay({ vaultDir, today }: { vaultDir: string; today: string }): Promise<boolean> {
  return withVaultLock({ vaultDir, waitMs: DAY_CLAIM_WAIT_MS }, async () => {
    const state = await readNightlyState(vaultDir);
    if (state.last_run_day !== undefined && state.last_run_day >= today) {
      return false;
    }
    await writeVaultStateFile({ vaultDir, name: NIGHTLY_STATE_FILE, value: { ...state, last_run_day: today } });
    return true;
  });
}
