/**
 * What the Memory pages screen does to a vault's pages: list, read, save a hand edit, confirm or dismiss an
 * Unconfirmed line, delete, and undo. Every change goes through `commitPageChange`, so each is one history entry
 * in plain words and the person's pending hand edits are taken in first.
 */
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';

import type {
  MemoryPageChange,
  MemoryPageLine,
  MemoryPageLineSource,
  MemoryPageListing,
  MemoryPageRef,
  MemoryPageSummary,
  MemoryPage as WirePage,
} from '../../schemas/memoryPages';
import { FactMarkerSchema } from './memoryNotes';
import { COMMENT_PATTERN, lineSide, singleLine } from './memoryPageLoader';
import { commitPageChange, markEditedPage, type PageChangeOptions } from './memoryPageWriter';
import {
  addFact,
  kindHasSection,
  listMemoryPages,
  listSkippedPageFiles,
  pageFacts,
  pagePath,
  pageSummary,
  parseMemoryPage,
  parsePageFilePath,
  readMemoryPage,
  removeFact,
  removeMemoryPage,
  renderMemoryPage,
  unmarkedBulletText,
  writeMemoryPage,
  type MemoryPage,
  type PageKind,
  type PageLine,
  type PageSection,
  type PageSectionBlock,
} from './memoryPages';
import { isPageSlug } from './pageSlug';
import {
  GitMissingError,
  pageBeforeCommit,
  pageCommit,
  pageCommitsAfter,
  pagePathsDiffering,
  recentPageCommits,
  type PageCommit,
  type VaultGitOptions,
} from './vaultGit';

/** How many history entries the screen lists. */
const CHANGES_SHOWN = 10;

/** The title a page is read with when its settings give none, so a missing title can be told from a real one. */
const NO_TITLE = '\u0000no title';

/** Why a change was refused, so the route can answer with the right status. */
type RefusalCode = 'not_found' | 'invalid' | 'conflict';

export interface Refusal {
  ok: false;
  code: RefusalCode;
  message: string;
}

export type ScreenOutcome<T> = { ok: true; value: T } | Refusal;

function refused<T>(code: RefusalCode, message: string): ScreenOutcome<T> {
  return { ok: false, code, message };
}

const SOURCE_LABELS: Readonly<Record<MemoryPageLineSource, string>> = {
  you_said: 'You said it',
  you_edited: 'You edited it',
  sent_mail: 'A message you sent',
  mail: 'Mail',
  calendar: 'Calendar',
  read_content: 'Something Aman read',
  inferred: 'Aman’s guess',
  unreadable: 'Aman could not read where this came from',
};

const RELOAD_MESSAGE = 'Reload the page to see what is there now.';

function clip(text: string): string {
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** Says which text a page was read from, so a save can tell that the page changed in between. */
function pageVersion(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

function withoutMarkers(markdown: string): string {
  return markdown.replace(COMMENT_PATTERN, '').replace(/[ \t]+$/gm, '');
}

function lineView({ line, section }: { line: PageLine; section: PageSectionBlock }): MemoryPageLine | undefined {
  const own = lineSide({ line, unconfirmed: section.name === 'Unconfirmed' }) === 'own';
  if (line.kind === 'fact') {
    const { marker } = line.fact;
    return {
      id: marker.id,
      text: line.fact.text,
      source: marker.src,
      source_label: SOURCE_LABELS[marker.src],
      own,
      since: marker.since ?? null,
      until: marker.until ?? null,
      seen: marker.seen ?? null,
    };
  }
  const text =
    line.kind === 'unreadable'
      ? singleLine(line.raw.replace(COMMENT_PATTERN, '').replace(/^\s*[-*]\s+/, ''))
      : (unmarkedBulletText(line.raw) ?? line.raw.trim());
  if (text === '') {
    return undefined;
  }
  const source = line.kind === 'unreadable' ? 'unreadable' : 'you_edited';
  return {
    id: null,
    text,
    source,
    source_label: SOURCE_LABELS[source],
    own,
    since: null,
    until: null,
    seen: null,
  };
}

function sectionLines(section: PageSectionBlock): MemoryPageLine[] {
  return section.lines.flatMap(line => {
    const view = lineView({ line, section });
    return view === undefined ? [] : [view];
  });
}

function unconfirmedCount(page: MemoryPage): number {
  const section = page.sections.find(candidate => candidate.name === 'Unconfirmed');
  return section === undefined ? 0 : sectionLines(section).length;
}

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Every page with its summary line, the day it last changed and how many lines wait to be confirmed. */
export async function listPagesForScreen(vaultDir: string): Promise<MemoryPageListing> {
  const pages: MemoryPageSummary[] = [];
  for (const { kind, slug } of await listMemoryPages(vaultDir)) {
    const page = await readMemoryPage({ vaultDir, kind, slug });
    if (page === undefined) {
      continue;
    }
    const changed = await stat(pagePath({ vaultDir, kind, slug })).then(
      file => dayOf(file.mtime),
      () => null,
    );
    pages.push({
      kind,
      slug,
      title: page.frontMatter.title,
      other_names: page.frontMatter.aliases,
      summary: pageSummary(page) ?? null,
      changed_on: changed,
      unconfirmed_count: unconfirmedCount(page),
    });
  }
  return { pages, skipped_files: await listSkippedPageFiles(vaultDir) };
}

function pageView({ kind, slug, page }: { kind: PageKind; slug: string; page: MemoryPage }): WirePage {
  const markdown = renderMemoryPage(page);
  return {
    kind,
    slug,
    title: page.frontMatter.title,
    other_names: page.frontMatter.aliases,
    summary: pageSummary(page) ?? null,
    sections: page.sections.map(section => ({ name: section.heading, lines: sectionLines(section) })),
    markdown,
    version: pageVersion(markdown),
  };
}

/** One page for the screen, or undefined when there is no such page. */
export async function readPageForScreen(input: {
  vaultDir: string;
  kind: PageKind;
  slug: string;
}): Promise<WirePage | undefined> {
  if (!isPageSlug(input.slug)) {
    return undefined;
  }
  const page = await readMemoryPage(input);
  return page === undefined ? undefined : pageView({ kind: input.kind, slug: input.slug, page });
}

const MISSING_PAGE = 'There is no page with that name. Reload the list.';

function lineIsUnreadable(line: PageLine): boolean {
  return line.kind === 'unreadable';
}

function unreadableLines(page: MemoryPage): string[] {
  return page.sections.flatMap(section => section.lines.filter(lineIsUnreadable).map(line => line.raw));
}

/** What to fix in a page the person wrote, or undefined when it can be saved. */
function problemWithEditedText({ markdown, before }: { markdown: string; before: MemoryPage }): string | undefined {
  if (markdown.trim() === '') {
    return 'Nothing was saved. The page is empty. Write the page again, or use Delete page to remove it.';
  }
  const edited = parseMemoryPage({ content: markdown, fallback: { kind: before.frontMatter.kind, title: NO_TITLE } });
  if (edited.frontMatterLines.length === 0) {
    return 'Nothing was saved. The page must start with its settings, between two lines of three dashes (---). Put them back at the top and save again.';
  }
  if (edited.frontMatter.title === NO_TITLE) {
    return 'Nothing was saved. The settings at the top have no title. Add a line such as "title: Wendy" and save again.';
  }
  const known = new Set(unreadableLines(before));
  const unreadable = unreadableLines(edited).find(raw => !known.has(raw));
  if (unreadable !== undefined) {
    return `Nothing was saved. This line has a hidden note that Aman cannot read: "${clip(singleLine(unreadable))}". Remove the part that starts with "<!--" and save again.`;
  }
  return undefined;
}

/**
 * Saves the person's new text for a page as one history entry, marked exactly as a hand edit made in the file is.
 * Refused when the page is no longer the version they started from, or when the text is not a page.
 */
export async function savePageEdit({
  options,
  kind,
  slug,
  markdown,
  version,
}: {
  options: PageChangeOptions;
  kind: PageKind;
  slug: string;
  markdown: string;
  version: string;
}): Promise<ScreenOutcome<WirePage>> {
  const { vaultDir, runner } = options;
  const before = isPageSlug(slug) ? await readMemoryPage({ vaultDir, kind, slug }) : undefined;
  if (before === undefined) {
    return refused('not_found', MISSING_PAGE);
  }
  const startedFrom = renderMemoryPage(before);
  const staleMessage = `Nothing was saved. This page changed after you opened it. ${RELOAD_MESSAGE}`;
  if (pageVersion(startedFrom) !== version) {
    return refused('conflict', staleMessage);
  }
  const problem = problemWithEditedText({ markdown, before });
  if (problem !== undefined) {
    return refused('invalid', problem);
  }
  return commitPageChange({
    options,
    message: `You: edited the page for ${clip(singleLine(before.frontMatter.title))}`,
    change: async ({ newId }) => {
      const now = await readMemoryPage({ vaultDir, kind, slug });
      if (now === undefined) {
        return refused('not_found', MISSING_PAGE);
      }
      // Taking in the person's earlier hand edits only adds markers, so a page that differs by markers alone is the same text.
      const current = renderMemoryPage(now);
      if (pageVersion(current) !== version && withoutMarkers(current) !== withoutMarkers(startedFrom)) {
        return refused('conflict', staleMessage);
      }
      const edited = parseMemoryPage({ content: markdown, fallback: { kind, title: slug } });
      const marked = await markEditedPage({
        history: { vaultDir, runner },
        relativePath: `${kind === 'person' ? 'people' : 'matters'}/${slug}.md`,
        page: edited,
        today: options.today,
        newId,
      });
      await writeMemoryPage({ vaultDir, kind, slug, page: marked });
      return { ok: true, value: pageView({ kind, slug, page: marked }) };
    },
  });
}

function unconfirmedFact({ page, factId }: { page: MemoryPage; factId: string }) {
  return pageFacts(page).find(at => at.section.name === 'Unconfirmed' && at.fact.marker.id === factId);
}

const NOT_WAITING = 'That line is not waiting to be confirmed any more. Reload the page to see what is there now.';

/** Moves an Unconfirmed line to a section as the person's own (`you_edited`), or removes it. */
async function changeUnconfirmedLine({
  options,
  kind,
  slug,
  factId,
  verb,
  apply,
}: {
  options: PageChangeOptions;
  kind: PageKind;
  slug: string;
  factId: string;
  verb: 'confirmed' | 'dismissed';
  apply: (input: { page: MemoryPage; at: NonNullable<ReturnType<typeof unconfirmedFact>> }) => MemoryPage;
}): Promise<ScreenOutcome<WirePage>> {
  const { vaultDir } = options;
  const before = isPageSlug(slug) ? await readMemoryPage({ vaultDir, kind, slug }) : undefined;
  if (before === undefined) {
    return refused('not_found', MISSING_PAGE);
  }
  const seen = unconfirmedFact({ page: before, factId });
  if (seen === undefined) {
    return refused('not_found', NOT_WAITING);
  }
  return commitPageChange({
    options,
    message: `You: ${verb} ${clip(seen.fact.text)} (${clip(singleLine(before.frontMatter.title))})`,
    change: async () => {
      const page = await readMemoryPage({ vaultDir, kind, slug });
      const at = page === undefined ? undefined : unconfirmedFact({ page, factId });
      if (page === undefined || at === undefined) {
        return refused('not_found', NOT_WAITING);
      }
      const changed = apply({ page, at });
      await writeMemoryPage({ vaultDir, kind, slug, page: changed });
      return { ok: true, value: pageView({ kind, slug, page: changed }) };
    },
  });
}

/** Confirms an Unconfirmed line: it moves to `section` (Now by default) as the person's own words. */
export async function confirmPageLine({
  options,
  kind,
  slug,
  factId,
  section = 'Now',
}: {
  options: PageChangeOptions;
  kind: PageKind;
  slug: string;
  factId: string;
  section?: PageSection | undefined;
}): Promise<ScreenOutcome<WirePage>> {
  if (!kindHasSection({ kind, section })) {
    return refused(
      'invalid',
      `Nothing was changed. A page for a ${kind} has no "${section}" section. Pick another section.`,
    );
  }
  return changeUnconfirmedLine({
    options,
    kind,
    slug,
    factId,
    verb: 'confirmed',
    apply: ({ page, at }) => {
      const marker = FactMarkerSchema.parse({
        kind: 'fact',
        id: at.fact.marker.id,
        src: 'you_edited',
        since: options.today,
      });
      return addFact(removeFact(page, { at }), { section, fact: { text: at.fact.text, marker } });
    },
  });
}

/** Dismisses an Unconfirmed line: it is removed from the page. */
export async function dismissPageLine(input: {
  options: PageChangeOptions;
  kind: PageKind;
  slug: string;
  factId: string;
}): Promise<ScreenOutcome<WirePage>> {
  return changeUnconfirmedLine({ ...input, verb: 'dismissed', apply: ({ page, at }) => removeFact(page, { at }) });
}

/** Deletes a page file. The history keeps it, so the delete can be undone. */
export async function deletePageFile({
  options,
  kind,
  slug,
}: {
  options: PageChangeOptions;
  kind: PageKind;
  slug: string;
}): Promise<ScreenOutcome<undefined>> {
  const { vaultDir } = options;
  const before = isPageSlug(slug) ? await readMemoryPage({ vaultDir, kind, slug }) : undefined;
  if (before === undefined) {
    return refused('not_found', MISSING_PAGE);
  }
  return commitPageChange({
    options,
    message: `You: deleted the page for ${clip(singleLine(before.frontMatter.title))}`,
    change: async () => {
      await removeMemoryPage({ vaultDir, kind, slug });
      return { ok: true, value: undefined };
    },
  });
}

function pageRefs(paths: readonly string[]): MemoryPageRef[] {
  return paths.flatMap(relativePath => {
    const at = parsePageFilePath(relativePath);
    return at === undefined ? [] : [{ kind: at.kind, slug: at.stem }];
  });
}

/**
 * A later change must be undone first when it left a page different from how this change left it. Changes that
 * cancelled each other out do not count, so an undo can itself be followed by the undo of the change before it.
 */
async function laterChange({
  history,
  commit,
}: {
  history: VaultGitOptions;
  commit: PageCommit;
}): Promise<PageCommit | undefined> {
  const differing = await pagePathsDiffering({ ...history, sha: commit.sha, paths: commit.paths });
  if (differing.length === 0) {
    return undefined;
  }
  const [newest] = await pageCommitsAfter({ ...history, sha: commit.sha, paths: differing });
  return newest;
}

/** The last changes to pages, newest first, each with the later change that blocks its undo. Empty with no history. */
export async function listPageChanges(
  history: VaultGitOptions,
): Promise<{ available: boolean; changes: MemoryPageChange[] }> {
  let commits: PageCommit[];
  try {
    commits = await recentPageCommits({ ...history, limit: CHANGES_SHOWN });
  } catch (error) {
    if (error instanceof GitMissingError) {
      return { available: false, changes: [] };
    }
    throw error;
  }
  const changes: MemoryPageChange[] = [];
  for (const commit of commits) {
    const blocking = await laterChange({ history, commit });
    changes.push({
      id: commit.sha,
      changed_at: commit.committedAt,
      message: commit.message,
      pages: pageRefs(commit.paths),
      undo_blocked_by: blocking?.message ?? null,
    });
  }
  return { available: true, changes };
}

const NO_SUCH_CHANGE = 'That change is no longer in the history. Reload the list of changes.';

const HISTORY_OFF = 'This server keeps no page history, so nothing can be undone. Edit the page by hand instead.';

/**
 * Undoes one change by putting the pages it touched back as they were just before it, as a new history entry.
 * History is never rewritten. Refused while a later change has left one of those pages different.
 */
export async function undoPageChange({
  options,
  changeId,
}: {
  options: PageChangeOptions;
  changeId: string;
}): Promise<ScreenOutcome<{ pages: MemoryPageRef[] }>> {
  const history: VaultGitOptions = { vaultDir: options.vaultDir, runner: options.runner };
  let commit: PageCommit | undefined;
  try {
    commit = await pageCommit({ ...history, sha: changeId });
  } catch (error) {
    if (error instanceof GitMissingError) {
      return refused('conflict', HISTORY_OFF);
    }
    throw error;
  }
  if (commit === undefined) {
    return refused('not_found', NO_SUCH_CHANGE);
  }
  const target = commit;
  const files = target.paths.map(relativePath => ({ relativePath, at: parsePageFilePath(relativePath) }));
  if (files.some(file => file.at?.isSlug !== true)) {
    return refused(
      'conflict',
      'That change touched a page file whose name Aman cannot read. Restore it from the memory folder by hand.',
    );
  }
  return commitPageChange({
    options,
    message: `You: undid "${clip(singleLine(target.message))}"`,
    change: async () => {
      const later = await laterChange({ history, commit: target });
      if (later !== undefined) {
        return refused(
          'conflict',
          `Nothing was undone. A later change, "${clip(singleLine(later.message))}", also changed these pages. Undo that change first.`,
        );
      }
      for (const { relativePath, at } of files) {
        if (at === undefined) {
          continue;
        }
        const target_ = { vaultDir: options.vaultDir, kind: at.kind, slug: at.stem };
        const earlier = await pageBeforeCommit({ ...history, sha: changeId, relativePath });
        if (earlier === undefined) {
          await removeMemoryPage(target_);
        } else {
          await writeMemoryPage({
            ...target_,
            page: parseMemoryPage({ content: earlier, fallback: { kind: at.kind, title: at.stem } }),
          });
        }
      }
      return { ok: true, value: { pages: pageRefs(target.paths) } };
    },
  });
}
