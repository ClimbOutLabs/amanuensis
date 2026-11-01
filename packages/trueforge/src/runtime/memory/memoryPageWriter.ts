/**
 * The one way a page changes on disk: under the vault lock, the person's own edits since the
 * last commit are taken in first as `Your edits`, then the change is written and committed.
 * Every writer (Settings, the chat tools, the nightly pass) goes through here.
 */
import type { HostCommandRunner } from '@truefoundry/trueforge-core/core/sandbox/slots/git/hostCommand';
import { randomBytes } from 'node:crypto';

import type { FactId } from './memoryNotes';
import {
  PAGE_FOLDERS,
  PAGE_KINDS,
  pageFacts,
  parseMemoryPage,
  readMemoryPage,
  renderMemoryPage,
  stampUnmarkedBullets,
  updateFactMarker,
  writeMemoryPage,
  type MemoryPage,
  type PageKind,
} from './memoryPages';
import { isPageSlug } from './pageSlug';
import { commitVault, ensureVaultRepo, vaultChangedPaths, vaultFileAtHead } from './vaultGit';
import { withVaultLock } from './vaultLock';

/** The commit subject for the person's own edits, taken in before any write by Aman. */
export const YOUR_EDITS_COMMIT_MESSAGE = 'Your edits';

/** A fresh fact id: `f_` and ten lowercase hex characters. */
export function newFactId(): FactId {
  return `f_${randomBytes(8).toString('hex').slice(0, 10)}`;
}

export interface PageWriterOptions {
  vaultDir: string;
  runner: HostCommandRunner;
  /** The vault's day, `YYYY-MM-DD`, for `since` on lines the person wrote by hand. */
  today: string;
  newId?: (() => FactId) | undefined;
}

/**
 * A page path relative to the vault, split into its kind and slug, or undefined for anything else.
 * A file whose name is not a lowercase slug is not a page: it is left alone, never read or committed by this writer.
 */
function pageAt(relativePath: string): { kind: PageKind; slug: string } | undefined {
  const [folder, file, ...rest] = relativePath.split('/');
  if (folder === undefined || file === undefined || rest.length > 0 || !file.endsWith('.md')) {
    return undefined;
  }
  const kind = PAGE_KINDS.find(candidate => PAGE_FOLDERS[candidate] === folder);
  const slug = file.slice(0, -'.md'.length);
  return kind === undefined || !isPageSlug(slug) ? undefined : { kind, slug };
}

/**
 * A hand-edited page with the person's changes marked as theirs: a fact whose text differs from
 * the committed copy gets `src=you_edited` (id and dates kept), and a bullet with no marker gets
 * a fresh id and `src=you_edited since=today`. Nothing else on the page is touched.
 */
export function markHandEdits(input: {
  page: MemoryPage;
  committed: MemoryPage | undefined;
  today: string;
  newId: () => FactId;
}): MemoryPage {
  const committedText = new Map(
    (input.committed === undefined ? [] : pageFacts(input.committed)).map(entry => [
      entry.fact.marker.id,
      entry.fact.text,
    ]),
  );
  let page = input.page;
  for (const entry of pageFacts(input.page)) {
    const before = committedText.get(entry.fact.marker.id);
    if (before !== undefined && before !== entry.fact.text && entry.fact.marker.src !== 'you_edited') {
      page = updateFactMarker(page, { id: entry.fact.marker.id, marker: { ...entry.fact.marker, src: 'you_edited' } });
    }
  }
  return stampUnmarkedBullets(page, { src: 'you_edited', since: input.today, newId: input.newId });
}

/**
 * Takes in every page the person changed since the last commit: marks their edits as theirs
 * and commits the lot as `Your edits`. Returns the paths taken in. Callers hold the lock.
 */
async function absorbHandEdits(options: PageWriterOptions & { newId: () => FactId }): Promise<string[]> {
  const changed = (await vaultChangedPaths(options)).filter(relativePath => pageAt(relativePath) !== undefined);
  for (const relativePath of changed) {
    const at = pageAt(relativePath);
    if (at === undefined) {
      continue;
    }
    const page = await readMemoryPage({ vaultDir: options.vaultDir, ...at });
    if (page === undefined) {
      continue;
    }
    const head = await vaultFileAtHead({ ...options, relativePath });
    const committed =
      head === undefined ? undefined : parseMemoryPage({ content: head, fallback: { kind: at.kind, title: at.slug } });
    const marked = markHandEdits({ page, committed, today: options.today, newId: options.newId });
    if (renderMemoryPage(marked) !== renderMemoryPage(page)) {
      await writeMemoryPage({ vaultDir: options.vaultDir, ...at, page: marked });
    }
  }
  if (changed.length > 0) {
    await commitVault({ ...options, message: YOUR_EDITS_COMMIT_MESSAGE });
  }
  return changed;
}

/**
 * Applies one change to the vault's pages as one commit. Under the lock: the repo is made
 * ready, the person's pending edits are committed first, then `change` runs (writing pages
 * with `writeMemoryPage`), then everything it wrote is committed under `message`. Returns the
 * commit, or `committed: false` when the change wrote nothing new.
 */
export async function commitPageChange<T>(
  options: PageWriterOptions & { message: string; body?: string | undefined },
  change: (context: { vaultDir: string; newId: () => FactId }) => Promise<T>,
): Promise<{ result: T; commit: { committed: true; sha: string } | { committed: false } }> {
  const newId = options.newId ?? newFactId;
  return withVaultLock({ vaultDir: options.vaultDir }, async lock => {
    await ensureVaultRepo(options);
    // Checked before each commit: a writer that lost its lock must not commit over the new holder.
    await lock.assertHeld();
    await absorbHandEdits({ ...options, newId });
    const result = await change({ vaultDir: options.vaultDir, newId });
    await lock.assertHeld();
    const commit = await commitVault({ ...options, message: options.message, body: options.body });
    return { result, commit };
  });
}
