import type { MemoryBankStatus } from '@truefoundry/trueforge-ui';

/** What the first screen reports about setup; re-read while the checklist still has work left. */
export interface SetupSnapshot {
  modelName: string | null;
  /** Shown in the runtime rail only; the checklist never asks about memory. */
  memoryBank: MemoryBankStatus | null | undefined;
  /** Whether at least one chat exists; undefined when the read failed, which leaves the line off. */
  hasChatted: boolean | undefined;
}

/** How often to re-read setup while the checklist is showing; the reads are two small list calls. */
export const SETUP_REFRESH_MS = 10_000;

/**
 * Complete means nothing on the checklist is left to do that a re-read could notice. An unknown
 * chat count counts as complete: the checklist leaves that line off, so there is nothing to keep
 * polling for. Memory never holds this back: it works out of the box. The owner's name is not
 * polled: the personalization profile updates in place when it is saved.
 */
export function isSetupComplete(setup: SetupSnapshot): boolean {
  const hasModel = setup.modelName !== null && setup.modelName.trim() !== '';
  const chatted = setup.hasChatted === undefined || setup.hasChatted;
  return hasModel && chatted;
}

/** Merges a re-read over the previous snapshot; a failed read (undefined) keeps what was known. */
export function mergeSetupRead(
  previous: SetupSnapshot | null,
  read: {
    modelName: string | null | undefined;
    memoryBank: MemoryBankStatus | null | undefined;
    hasChatted: boolean | undefined;
  },
): SetupSnapshot {
  return {
    modelName: read.modelName === undefined ? (previous?.modelName ?? null) : read.modelName,
    memoryBank: read.memoryBank === undefined ? previous?.memoryBank : read.memoryBank,
    hasChatted: read.hasChatted ?? previous?.hasChatted,
  };
}
