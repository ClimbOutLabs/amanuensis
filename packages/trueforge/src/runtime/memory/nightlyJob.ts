/**
 * The small nightly job for pages. Once a day per vault, in the quiet hours, it moves ended statements to Earlier,
 * sorts notes that were missed, and lists statements that disagree. It changes nothing else. The vault lock is
 * taken for each small change, never around a model call, so a save or a page edit is never held up by it.
 */
import { extractErrorLogFields, type HostCommandRunner } from '@truefoundry/trueforge-core/core';
import { stat } from 'node:fs/promises';
import type { Logger } from 'winston';

import { moveEndedStatements } from './endedStatements';
import { namespaceDirFor } from './markdownMemoryFiles';
import type { PageListing } from './memoryPages';
import type { SummarizeTurnContext } from './memoryRetain';
import { sortMissedNotes } from './missedNotes';
import { claimNightlyDay } from './nightlyState';
import { listDisagreements, summaryModelForDisagreements } from './pageDisagreements';
import type { PageSortMode } from './pageSortMode';
import { summaryModelForSorting } from './pageSortRun';
import { VaultBusyError } from './vaultLock';

/** How many hours after the chosen hour the job may still start; it never starts past the end of that day. */
const START_WINDOW_HOURS = 3;

/** One vault the job tidies: a person's own, or a persona's. */
export interface NightlyVault {
  /** The vault's folder name under the memory folder. */
  namespace: string;
  /** Set for a persona's vault. */
  persona?: { id: string; name: string; modelName: string } | undefined;
}

export interface NightlyDeps {
  baseDir: string;
  mode: PageSortMode;
  /** The hour of the server's day, 0 to 23, from which the job may start. */
  hour: number;
  now: () => Date;
  vaults: () => Promise<NightlyVault[]>;
  /** What the summary model needs for this vault, or undefined when no model is configured. */
  summarizeFor: (vault: NightlyVault) => Promise<SummarizeTurnContext | undefined>;
  similarPagesFor: (vault: NightlyVault) => ((text: string) => Promise<PageListing[]>) | undefined;
  runner: HostCommandRunner;
  logger: Logger;
}

/** What one vault's run did, in counts only. */
export interface NightlyCounts {
  movedToEarlier: number;
  notesAsked: number;
  notesSorted: number;
  pagesAsked: number;
  pairsListed: number;
  /** Vaults where sorting was not off but no model could be found, so the steps that ask one were skipped. */
  vaultsWithoutModel: number;
  /** Why notes were left unsorted, each different reason once. It may quote the model, so it is not logged here. */
  unsortedReasons: string[];
}

export type NightlyOutcome =
  { status: 'skipped'; reason: 'no_vault' | 'already_ran' | 'busy' } | { status: 'ran'; counts: NightlyCounts };

/** The server's calendar day, `YYYY-MM-DD`, on the server's own clock. */
export function serverDay(now: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${String(now.getFullYear())}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/** Whether the server's clock is in the hours the job may start in, from the chosen hour on. */
export function inQuietHours({ now, hour }: { now: Date; hour: number }): boolean {
  return now.getHours() >= hour && now.getHours() < Math.min(hour + START_WINDOW_HOURS, 24);
}

async function vaultExists(vaultDir: string): Promise<boolean> {
  try {
    return (await stat(vaultDir)).isDirectory();
  } catch {
    return false;
  }
}

/** Runs one step; a failure is logged and the next step still runs. */
async function attempt<T>({
  step,
  logger,
  work,
}: {
  step: string;
  logger: Logger;
  work: () => Promise<T>;
}): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    logger.warn('A step of the nightly memory tidy failed.', { step, ...extractErrorLogFields(error) });
    return undefined;
  }
}

/**
 * Tidies one vault if today has not been taken for it yet. The day is taken under the vault lock before any work,
 * so a second server process skips the vault, and a crash halfway is repeated the next day. A run the person asked
 * for (`onRequest`) neither checks nor takes the day, so it runs now and the daily run still happens.
 */
export async function runNightlyForVault({
  vault,
  deps,
  onRequest = false,
}: {
  vault: NightlyVault;
  deps: NightlyDeps;
  onRequest?: boolean;
}): Promise<NightlyOutcome> {
  const { baseDir, mode, logger } = deps;
  const vaultDir = namespaceDirFor(baseDir, vault.namespace);
  if (!(await vaultExists(vaultDir))) {
    return { status: 'skipped', reason: 'no_vault' };
  }
  const today = serverDay(deps.now());
  if (!onRequest) {
    try {
      if (!(await claimNightlyDay({ vaultDir, today }))) {
        return { status: 'skipped', reason: 'already_ran' };
      }
    } catch (error) {
      if (error instanceof VaultBusyError) {
        return { status: 'skipped', reason: 'busy' };
      }
      throw error;
    }
  }

  const options = { vaultDir, runner: deps.runner, today, logger };
  const counts: NightlyCounts = {
    movedToEarlier: 0,
    notesAsked: 0,
    notesSorted: 0,
    pagesAsked: 0,
    pairsListed: 0,
    vaultsWithoutModel: 0,
    unsortedReasons: [],
  };
  counts.movedToEarlier =
    (await attempt({ step: 'ended statements', logger, work: () => moveEndedStatements({ options }) })) ?? 0;

  const summarize =
    mode === 'off'
      ? undefined
      : await attempt({ step: 'find the model', logger, work: () => deps.summarizeFor(vault) });
  if (mode !== 'off' && summarize === undefined) {
    counts.vaultsWithoutModel = 1;
  }
  const sortModel = summarize === undefined ? undefined : summaryModelForSorting({ summarize, logger });
  const disagreementModel = summarize === undefined ? undefined : summaryModelForDisagreements({ summarize, logger });
  if (sortModel !== undefined) {
    const missed = await attempt({
      step: 'missed notes',
      logger,
      work: () =>
        sortMissedNotes({
          mode,
          baseDir,
          namespace: vault.namespace,
          options,
          askModel: sortModel,
          similarPages: deps.similarPagesFor(vault),
          // A run the person asked for can be repeated at once, so it is not a night a note failed on.
          countFailedNight: !onRequest,
        }),
    });
    counts.notesAsked = missed?.asked ?? 0;
    counts.notesSorted = missed?.sorted ?? 0;
    counts.unsortedReasons = missed?.reasons ?? [];
  }
  if (disagreementModel !== undefined) {
    const found = await attempt({
      step: 'lines that disagree',
      logger,
      work: () => listDisagreements({ vaultDir, today, askModel: disagreementModel, logger }),
    });
    counts.pagesAsked = found?.asked ?? 0;
    counts.pairsListed = found?.listed ?? 0;
  }
  const { unsortedReasons, ...numbers } = counts;
  logger.info('Nightly memory tidy finished for a vault.', {
    personaId: vault.persona?.id,
    ...numbers,
    unsortedReasons: unsortedReasons.length,
  });
  return { status: 'ran', counts };
}

/**
 * Tidies every vault one after the other and adds up what was done. A failure in one vault is logged and the
 * others still run. The daily run stops starting vaults once its hours end; a run the person asked for does not.
 */
export async function runNightlyJob({
  deps,
  onRequest = false,
}: {
  deps: NightlyDeps;
  onRequest?: boolean;
}): Promise<NightlyCounts> {
  const total: NightlyCounts = {
    movedToEarlier: 0,
    notesAsked: 0,
    notesSorted: 0,
    pagesAsked: 0,
    pairsListed: 0,
    vaultsWithoutModel: 0,
    unsortedReasons: [],
  };
  for (const vault of await deps.vaults()) {
    if (!onRequest && !inQuietHours({ now: deps.now(), hour: deps.hour })) {
      break;
    }
    try {
      const outcome = await runNightlyForVault({ vault, deps, onRequest });
      if (outcome.status === 'ran') {
        total.movedToEarlier += outcome.counts.movedToEarlier;
        total.notesAsked += outcome.counts.notesAsked;
        total.notesSorted += outcome.counts.notesSorted;
        total.pagesAsked += outcome.counts.pagesAsked;
        total.pairsListed += outcome.counts.pairsListed;
        total.vaultsWithoutModel += outcome.counts.vaultsWithoutModel;
        total.unsortedReasons = [...new Set([...total.unsortedReasons, ...outcome.counts.unsortedReasons])];
      }
    } catch (error) {
      deps.logger.warn('The nightly memory tidy failed for a vault.', {
        personaId: vault.persona?.id,
        ...extractErrorLogFields(error),
      });
    }
  }
  return total;
}
