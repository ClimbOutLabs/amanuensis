/**
 * The one way a page changes on disk. Under the vault lock, the person's own edits since the last commit are
 * taken in first and committed as "Your edits"; then the change is made and committed under its own message.
 */
import type { HostCommandRunner } from '@truefoundry/trueforge-core/core';
import { randomBytes } from 'node:crypto';
import type { Logger } from 'winston';

import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import { FactMarkerSchema } from './memoryNotes';
import {
  pageFacts,
  parseMemoryPage,
  parsePageFilePath,
  readMemoryPage,
  renderMemoryPage,
  stampUnmarkedBullets,
  withFactMarker,
  writeMemoryPage,
  type MemoryPage,
} from './memoryPages';
import {
  changedPagePaths,
  commitPages,
  ensureHistory,
  GitMissingError,
  pageAtLastCommit,
  VaultGitError,
  type VaultGitOptions,
} from './vaultGit';
import { withVaultLock } from './vaultLock';

/** The commit message for the person's own edits, taken in before any change by Aman. */
export const YOUR_EDITS_COMMIT_MESSAGE = 'Your edits';

/** A new fact id: `f_` and ten lowercase hex characters. */
export function newFactId(): string {
  return `f_${randomBytes(5).toString('hex')}`;
}

export interface PageChangeOptions {
  vaultDir: string;
  runner: HostCommandRunner;
  /** The vault's day as `YYYY-MM-DD`, written as `since` on lines the person wrote by hand. */
  today: string;
  logger: Logger;
  /** Makes fact ids; tests supply their own. */
  newId?: (() => string) | undefined;
  /** How long to wait for another change to the vault to finish; the usual wait when left out. */
  lockWaitMs?: number | undefined;
}

/** Vaults whose history was skipped because git is missing, so the plain log line appears once per vault. */
const historyOffLogged = new Set<string>();

/**
 * The page with the person's hand edits marked as theirs. A fact whose text differs from the committed copy of
 * the same id gets `src=you_edited` (id and dates kept, text untouched). A bullet with no marker gets a new id,
 * `src=you_edited` and `since=today`. Only the marker is written; a line with an unreadable marker is left alone,
 * so it stays unreadable and unconfirmed.
 */
export function markHandEdits({
  page,
  committed,
  today,
  newId,
}: {
  page: MemoryPage;
  committed: MemoryPage | undefined;
  today: string;
  newId: () => string;
}): MemoryPage {
  const committedText = new Map<string, string>();
  for (const { fact } of committed === undefined ? [] : pageFacts(committed)) {
    if (!committedText.has(fact.marker.id)) {
      committedText.set(fact.marker.id, fact.text);
    }
  }
  let marked = page;
  for (const at of pageFacts(page)) {
    const before = committedText.get(at.fact.marker.id);
    if (before !== undefined && before !== at.fact.text && at.fact.marker.src !== 'you_edited') {
      marked = withFactMarker(marked, { at, marker: { ...at.fact.marker, src: 'you_edited' } });
    }
  }
  const taken = new Set(pageFacts(marked).map(({ fact }) => fact.marker.id));
  return stampUnmarkedBullets(marked, () => {
    let id = newId();
    while (taken.has(id)) {
      id = newId();
    }
    taken.add(id);
    return FactMarkerSchema.parse({ kind: 'fact', id, src: 'you_edited', since: today });
  });
}

/**
 * A page the person wrote by hand, marked as theirs against the last committed copy of the same file. With no
 * history (git missing) nothing is committed, so only bullets without a marker are stamped.
 */
export async function markEditedPage({
  history,
  relativePath,
  page,
  today,
  newId,
}: {
  history: VaultGitOptions;
  relativePath: string;
  page: MemoryPage;
  today: string;
  newId: () => string;
}): Promise<MemoryPage> {
  const at = parsePageFilePath(relativePath);
  if (at === undefined) {
    return page;
  }
  let head: string | undefined;
  try {
    head = await pageAtLastCommit({ ...history, relativePath });
  } catch (error) {
    if (!(error instanceof GitMissingError)) {
      throw error;
    }
  }
  const committed =
    head === undefined ? undefined : parseMemoryPage({ content: head, fallback: { kind: at.kind, title: at.stem } });
  return markHandEdits({ page, committed, today, newId });
}

/** Takes in every page the person changed since the last commit and commits them as "Your edits". */
async function absorbHandEdits({
  history,
  today,
  newId,
}: {
  history: VaultGitOptions;
  today: string;
  newId: () => string;
}): Promise<void> {
  const changed = await changedPagePaths(history);
  for (const relativePath of changed) {
    const at = parsePageFilePath(relativePath);
    if (at?.isSlug !== true) {
      continue;
    }
    const page = await readMemoryPage({ vaultDir: history.vaultDir, kind: at.kind, slug: at.stem });
    if (page === undefined) {
      continue;
    }
    const marked = await markEditedPage({ history, relativePath, page, today, newId });
    if (renderMemoryPage(marked) !== renderMemoryPage(page)) {
      await writeMemoryPage({ vaultDir: history.vaultDir, kind: at.kind, slug: at.stem, page: marked });
    }
  }
  if (changed.length > 0) {
    await commitPages({ ...history, message: YOUR_EDITS_COMMIT_MESSAGE });
  }
}

/** The history ready for use, or undefined when git is missing (logged once per vault). */
async function readyHistory({
  options,
  history,
}: {
  options: PageChangeOptions;
  history: VaultGitOptions;
}): Promise<VaultGitOptions | undefined> {
  try {
    await ensureHistory(history);
    return history;
  } catch (error) {
    if (!(error instanceof GitMissingError)) {
      throw error;
    }
    if (!historyOffLogged.has(options.vaultDir)) {
      historyOffLogged.add(options.vaultDir);
      options.logger.warn(error.message);
    }
    return undefined;
  }
}

/**
 * Makes one change to a vault's pages as one commit. Under the vault lock: the history is made ready, the
 * person's pending edits are committed first, then `change` runs and writes pages with `writeMemoryPage`, then
 * what it wrote is committed under `message`. With no git on the server the change is still made, without history.
 * A history that fails before the change stops it, so nothing is written; one that fails after is logged, since the
 * page is already saved.
 */
export async function commitPageChange<T>({
  options,
  message,
  change,
}: {
  options: PageChangeOptions;
  /** A function is called with what `change` returned, for a message that counts what the change did. */
  message: string | ((result: T) => string);
  change: (context: { newId: () => string }) => Promise<T>;
}): Promise<T> {
  const newId = options.newId ?? newFactId;
  return withVaultLock({ vaultDir: options.vaultDir, waitMs: options.lockWaitMs }, async lock => {
    const history = await readyHistory({
      options,
      history: { vaultDir: options.vaultDir, runner: options.runner },
    });
    if (history !== undefined) {
      await lock.assertHeld();
      await absorbHandEdits({ history, today: options.today, newId });
    }
    await lock.assertHeld();
    const result = await change({ newId });
    if (history !== undefined) {
      try {
        await lock.assertHeld();
        await commitPages({ ...history, message: typeof message === 'function' ? message(result) : message });
      } catch (error) {
        if (!(error instanceof VaultGitError)) {
          throw error;
        }
        options.logger.warn(
          'A page was saved but its history entry could not be written.',
          extractErrorLogFields(error),
        );
      }
    }
    return result;
  });
}
