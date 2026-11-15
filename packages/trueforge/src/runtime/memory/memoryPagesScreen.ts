/**
 * What the Memory pages screen does to a vault's pages: list, read, save a hand edit, confirm or dismiss an
 * Unconfirmed line, delete, and undo. Every change goes through `commitPageChange`, so each is one history entry
 * in plain words and the person's pending hand edits are taken in first.
 */
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';

import {
  ConfirmableMemoryPageSectionSchema,
  type MemoryPageChange,
  type MemoryPageDisagreement,
  type MemoryPageLine,
  type MemoryPageLineSource,
  type MemoryPageListing,
  type MemoryPageRef,
  type MemoryPageSummary,
  type MemoryPage as WirePage,
} from '../../schemas/memoryPages';
import { FactMarkerSchema } from './memoryNotes';
import { COMMENT_PATTERN, lineSide, singleLine } from './memoryPageLoader';
import {
  addFact,
  kindHasSection,
  listMemoryPages,
  listSkippedPageFiles,
  pageDescription,
  pageFacts,
  pageFolder,
  pagePath,
  parseMemoryPage,
  parsePageFilePath,
  readMemoryPage,
  removeFact,
  removeMemoryPage,
  renderMemoryPage,
  unmarkedBulletText,
  withPageTitle,
  writeMemoryPage,
  type MemoryPage,
  type PageKind,
  type PageLine,
  type PageSection,
  type PageSectionBlock,
} from './memoryPages';
import { commitPageChange, markEditedPage, type PageChangeOptions } from './memoryPageWriter';
import { dismissDisagreement, readDisagreementsForScreen, type LiveDisagreement } from './pageDisagreements';
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
  you_said: 'From you',
  you_edited: 'From you',
  sent_mail: 'External source: a message you sent',
  mail: 'External source: email',
  calendar: 'External source: calendar',
  read_content: 'External source: read content',
  inferred: 'External source: Aman’s guess',
  unreadable: 'Aman could not read where this came from',
};

/** How the history line of an undo starts, so the screen can offer to put the change back. */
const UNDO_MESSAGE_START = 'You: undid ';

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

/** A stored line as the person reads it: no hidden note and no space at its end. */
function visibleText(raw: string): string {
  return raw.replace(/\r$/, '').replace(COMMENT_PATTERN, '').trimEnd();
}

/**
 * Stored lines the editor shows as one line: a line on its own, or a line with the lines its hidden note runs
 * over. `shown` is what the person reads; `stored` is what goes back in the file when they leave it alone.
 */
interface EditorLine {
  heading: string | undefined;
  shown: string;
  stored: string[];
}

function withEnding(line: PageLine): string {
  return `${line.raw}${line.crlf ? '\r' : ''}`;
}

/** A section's lines for the editor. A hidden note that runs on to later lines keeps those lines with its own. */
function sectionEditorLines(section: PageSectionBlock): EditorLine[] {
  const grouped: PageLine[][] = [];
  let open = false;
  for (const [index, line] of section.lines.entries()) {
    const previous = section.lines[index - 1];
    // A note wrapped onto its own line belongs to the bullet above, which is read as unconfirmed because of it.
    const wrapped =
      previous?.kind === 'unreadable' && !previous.raw.includes('<!--') && line.raw.trimStart().startsWith('<!--');
    const last = grouped.at(-1);
    if (last !== undefined && (open || wrapped)) {
      last.push(line);
    } else {
      grouped.push([line]);
    }
    open = line.raw.lastIndexOf('<!--') > line.raw.lastIndexOf('-->') || (open && !line.raw.includes('-->'));
  }
  return grouped.map(lines => ({
    heading: section.heading,
    shown: lines
      .map(line => visibleText(line.raw))
      .filter(text => text.trim() !== '')
      .join(' '),
    stored: lines.map(withEnding),
  }));
}

/** Every line of the page body for the editor, in page order: the lines above the first heading, then each section. */
function editorLines(page: MemoryPage): EditorLine[] {
  const one = (raw: string, heading: string | undefined): EditorLine => ({
    heading,
    shown: visibleText(raw),
    stored: [raw],
  });
  return [
    ...page.preamble.map(raw => one(raw, undefined)),
    ...page.sections.flatMap(section => [
      one(`${section.rawHeading}${section.crlf ? '\r' : ''}`, section.heading),
      ...sectionEditorLines(section),
    ]),
  ];
}

const NAME_LINE_START = '# ';
const SECTION_LINE_START = '## ';

/**
 * The page as the person edits it: its name, its headings and its lines, with the settings and hidden notes left
 * out. The first line is always the name from the settings, whatever the title line in the file says, because
 * saving reads the name back from that line.
 */
function pageEditText(page: MemoryPage): string {
  const shown = editorLines(page).map(line => line.shown);
  const first = shown.findIndex(line => line !== '');
  const rest = shown[first]?.startsWith(NAME_LINE_START) === true ? shown.slice(first + 1) : ['', ...shown];
  const nameLine = `${NAME_LINE_START}${singleLine(page.frontMatter.title)}`;
  return `${[nameLine, ...rest].join('\n').trimEnd()}\n`;
}

function refusedEdit(message: string): Refusal {
  return { ok: false, code: 'invalid', message };
}

/**
 * The page the person's edited text stands for. A line they left as it was shown goes back as it is stored, so it
 * keeps where it came from and its dates; it is looked for under the same heading first, then anywhere on the page.
 * Every other line is theirs as typed. The first line names the page. The settings block is never theirs to break.
 */
function pageFromEditText({
  text,
  from,
  kind,
  slug,
}: {
  text: string;
  from: MemoryPage;
  kind: PageKind;
  slug: string;
}): ScreenOutcome<MemoryPage> {
  if (text.trim() === '') {
    return refusedEdit('Nothing was saved. The page is empty. Write the page again, or use Delete page to remove it.');
  }
  if (text.includes('<!--') || text.includes('-->')) {
    return refusedEdit(
      'Nothing was saved. A line holds "<!--" or "-->", which Aman keeps for its own hidden notes. Remove those marks and save again.',
    );
  }
  const typed = text
    .replace(/\r\n?/g, '\n')
    .trimEnd()
    .split('\n')
    .map(line => line.trimEnd());
  const firstWritten = typed.findIndex(line => line !== '');
  const nameLine = typed[firstWritten] ?? '';
  // Line ends are trimmed, so a name line with its name deleted is a lone "#".
  const named = nameLine === '#' || nameLine.startsWith(NAME_LINE_START);
  const title = named ? singleLine(nameLine.slice(NAME_LINE_START.length)).trim() : from.frontMatter.title;
  if (title === '') {
    return refusedEdit(
      'Nothing was saved. The page has no name. Write the name on the first line after "# " and save again.',
    );
  }
  const renamed = title === from.frontMatter.title ? from : withPageTitle(from, title);
  if (renamed === undefined) {
    return refusedEdit(
      `Nothing was saved. This page's name cannot be changed here. Put the first line back to "# ${clip(singleLine(from.frontMatter.title))}" and save again.`,
    );
  }
  const body = named
    ? [`${NAME_LINE_START}${title}`, ...typed.slice(firstWritten + 1)]
    : [`${NAME_LINE_START}${title}`, '', ...typed.slice(firstWritten)];

  // Only lines that hold something hidden need putting back; the rest are the same typed or stored.
  const kept = editorLines(from)
    .filter(line => line.shown !== '' && (line.stored.length > 1 || line.stored[0] !== line.shown))
    .map(line => ({ ...line, used: false }));
  const out: (string[] | undefined)[] = body.map(() => undefined);
  const headings: (string | undefined)[] = [];
  let heading: string | undefined;
  for (const line of body) {
    if (line.startsWith(SECTION_LINE_START)) {
      heading = line.slice(SECTION_LINE_START.length).trim();
    }
    headings.push(heading);
  }
  for (const sameHeading of [true, false]) {
    for (const [index, line] of body.entries()) {
      if (out[index] !== undefined || line === '') {
        continue;
      }
      const match = kept.find(
        candidate =>
          !candidate.used && candidate.shown === line && (!sameHeading || candidate.heading === headings[index]),
      );
      if (match !== undefined) {
        match.used = true;
        out[index] = match.stored;
      }
    }
  }
  const lines = [...renamed.frontMatterLines, ...body.flatMap((line, index) => out[index] ?? [line])];
  return {
    ok: true,
    value: parseMemoryPage({
      content: `${from.hasBom ? '\uFEFF' : ''}${lines.join('\n')}\n`,
      fallback: { kind, title: slug },
    }),
  };
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

function disagreementView(pair: LiveDisagreement): MemoryPageDisagreement {
  return { id: pair.id, first: pair.first, second: pair.second, reason: pair.reason, found_on: pair.foundOn };
}

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Every page with its summary line, the day it last changed and how many lines wait to be confirmed. */
export async function listPagesForScreen(vaultDir: string): Promise<MemoryPageListing> {
  const pages: MemoryPageSummary[] = [];
  const disagreementsOf = await readDisagreementsForScreen(vaultDir);
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
      summary: pageDescription(page) ?? null,
      changed_on: changed,
      disagreement_count: disagreementsOf({ kind, slug, page }).length,
    });
  }
  return { pages, skipped_files: await listSkippedPageFiles(vaultDir) };
}

async function pageView({
  vaultDir,
  kind,
  slug,
  page,
}: {
  vaultDir: string;
  kind: PageKind;
  slug: string;
  page: MemoryPage;
}): Promise<WirePage> {
  const markdown = renderMemoryPage(page);
  const disagreementsOf = await readDisagreementsForScreen(vaultDir);
  return {
    kind,
    slug,
    title: page.frontMatter.title,
    other_names: page.frontMatter.aliases,
    summary: pageDescription(page) ?? null,
    sections: page.sections.map(section => ({ name: section.heading, lines: sectionLines(section) })),
    text: pageEditText(page),
    confirmable_sections: ConfirmableMemoryPageSectionSchema.options.filter(section =>
      kindHasSection({ kind, section }),
    ),
    version: pageVersion(markdown),
    disagreements: disagreementsOf({ kind, slug, page }).map(disagreementView),
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
  return page === undefined
    ? undefined
    : pageView({ vaultDir: input.vaultDir, kind: input.kind, slug: input.slug, page });
}

const MISSING_PAGE = 'There is no page with that name. Reload the list.';

/**
 * Saves the person's edited text for a page as one history entry, marked exactly as a hand edit made in the file is.
 * Refused when the page is no longer the version they started from, or when the text is not a page.
 */
export async function savePageEdit({
  options,
  kind,
  slug,
  text,
  version,
}: {
  options: PageChangeOptions;
  kind: PageKind;
  slug: string;
  text: string;
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
  const problem = pageFromEditText({ text, from: before, kind, slug });
  if (!problem.ok) {
    return problem;
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
      const edited = pageFromEditText({ text, from: now, kind, slug });
      if (!edited.ok) {
        return edited;
      }
      const marked = await markEditedPage({
        history: { vaultDir, runner },
        relativePath: `${pageFolder(kind)}/${slug}.md`,
        page: edited.value,
        today: options.today,
        newId,
      });
      await writeMemoryPage({ vaultDir, kind, slug, page: marked });
      return { ok: true, value: await pageView({ vaultDir, kind, slug, page: marked }) };
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
      return { ok: true, value: await pageView({ vaultDir, kind, slug, page: changed }) };
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

const NOT_LISTED = 'That pair is not listed any more. Reload the page to see what is there now.';

/** Marks a pair of lines as not a problem. No line on the page changes and no history entry is made. */
export async function dismissPageDisagreement({
  vaultDir,
  kind,
  slug,
  disagreementId,
}: {
  vaultDir: string;
  kind: PageKind;
  slug: string;
  disagreementId: string;
}): Promise<ScreenOutcome<WirePage>> {
  const page = isPageSlug(slug) ? await readMemoryPage({ vaultDir, kind, slug }) : undefined;
  if (page === undefined) {
    return refused('not_found', MISSING_PAGE);
  }
  if (!(await dismissDisagreement({ vaultDir, kind, slug, id: disagreementId }))) {
    return refused('not_found', NOT_LISTED);
  }
  return { ok: true, value: await pageView({ vaultDir, kind, slug, page }) };
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
      is_undo: commit.message.startsWith(UNDO_MESSAGE_START),
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
    message: `${UNDO_MESSAGE_START}"${clip(singleLine(target.message))}"`,
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
