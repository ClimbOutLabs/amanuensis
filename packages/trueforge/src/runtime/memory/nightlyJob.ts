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

/** The job starts in the server's local hours from this one up to, not including, the next. */
const QUIET_HOURS = { from: 2, until: 5 } as const;

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
}

export type NightlyOutcome =
  { status: 'skipped'; reason: 'no_vault' | 'already_ran' | 'busy' } | { status: 'ran'; counts: NightlyCounts };

/** The server's calendar day, `YYYY-MM-DD`, on the server's own clock. */
export function serverDay(now: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${String(now.getFullYear())}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/** Whether the server's clock is in the quiet hours. */
export function inQuietHours(now: Date): boolean {
  return now.getHours() >= QUIET_HOURS.from && now.getHours() < QUIET_HOURS.until;
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
 * so a second server process skips the vault, and a crash halfway is repeated the next day.
 */
export async function runNightlyForVault({
  vault,
  deps,
}: {
  vault: NightlyVault;
  deps: NightlyDeps;
}): Promise<NightlyOutcome> {
  const { baseDir, mode, logger } = deps;
  const vaultDir = namespaceDirFor(baseDir, vault.namespace);
  if (!(await vaultExists(vaultDir))) {
    return { status: 'skipped', reason: 'no_vault' };
  }
  const today = serverDay(deps.now());
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

  const options = { vaultDir, runner: deps.runner, today, logger };
  const counts: NightlyCounts = { movedToEarlier: 0, notesAsked: 0, notesSorted: 0, pagesAsked: 0, pairsListed: 0 };
  counts.movedToEarlier =
    (await attempt({ step: 'ended statements', logger, work: () => moveEndedStatements({ options }) })) ?? 0;

  const summarize =
    mode === 'off'
      ? undefined
      : await attempt({ step: 'find the model', logger, work: () => deps.summarizeFor(vault) });
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
        }),
    });
    counts.notesAsked = missed?.asked ?? 0;
    counts.notesSorted = missed?.sorted ?? 0;
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
  logger.info('Nightly memory tidy finished for a vault.', { personaId: vault.persona?.id, ...counts });
  return { status: 'ran', counts };
}

/** Tidies every vault one after the other. A failure in one vault is logged and the others still run. Stops starting vaults once the quiet hours end. */
export async function runNightlyJob(deps: NightlyDeps): Promise<void> {
  for (const vault of await deps.vaults()) {
    if (!inQuietHours(deps.now())) {
      return;
    }
    try {
      await runNightlyForVault({ vault, deps });
    } catch (error) {
      deps.logger.warn('The nightly memory tidy failed for a vault.', {
        personaId: vault.persona?.id,
        ...extractErrorLogFields(error),
      });
    }
  }
}
