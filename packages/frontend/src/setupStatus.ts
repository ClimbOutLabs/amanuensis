import type { MemoryBankStatus } from '@truefoundry/trueforge-ui';

/** What the first screen reports about setup; re-read while anything here is still unset. */
export interface SetupSnapshot {
  modelName: string | null;
  memoryBank: MemoryBankStatus | null | undefined;
}

/** How often to re-read setup while the checklist is showing; the reads are two small list calls. */
export const SETUP_REFRESH_MS = 10_000;

/**
 * Complete means nothing on the first screen is left to do. An unknown memory state counts as
 * complete: the screens say nothing about it, so there is nothing to keep polling for.
 */
export function isSetupComplete(setup: SetupSnapshot): boolean {
  const hasModel = setup.modelName !== null && setup.modelName.trim() !== '';
  const memoryReady = setup.memoryBank === undefined || setup.memoryBank?.connected === true;
  return hasModel && memoryReady;
}

/** Merges a re-read over the previous snapshot; a failed read (undefined) keeps what was known. */
export function mergeSetupRead(
  previous: SetupSnapshot | null,
  read: { modelName: string | null | undefined; memoryBank: MemoryBankStatus | null | undefined },
): SetupSnapshot {
  return {
    modelName: read.modelName === undefined ? (previous?.modelName ?? null) : read.modelName,
    memoryBank: read.memoryBank === undefined ? previous?.memoryBank : read.memoryBank,
  };
}
