import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { appendHandledNote, readHandledNotes } from '../../../../src/runtime/memory/handledNotes';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { namespaceDirFor, scanNamespaceEntries } from '../../../../src/runtime/memory/markdownMemoryFiles';
import type { RetainItem } from '../../../../src/runtime/memory/memoryClient';
import { labeledNoteText, noteLabel } from '../../../../src/runtime/memory/memoryNotes';
import { USER_STATED_ORIGIN } from '../../../../src/runtime/memory/memoryOrigin';
import { pagePath } from '../../../../src/runtime/memory/memoryPages';
import { buildRetainItem, noteRetainItem } from '../../../../src/runtime/memory/memoryRetain';
import { MAYA_ENTRIES } from './entries';
import { MAYA_EVENTS } from './events';
import { mayaDate, mayaPageBySlug } from './pages';
import type { MayaEntry, MayaEvent } from './schema';
import { writeMayaSortedPages } from './sortedPages';

/** The vault Maya's world is written into. */
export const MAYA_NAMESPACE = 'maya';

/** The name notes about the assistant's replies carry in this world. */
export const MAYA_ASSISTANT_NAME = 'Aman';

export function retainItemOf(entry: MayaEntry): RetainItem {
  const turnId = `turn-${entry.id}`;
  if (entry.origin === USER_STATED_ORIGIN) {
    const item = buildRetainItem({
      sessionId: entry.session,
      turnId,
      userText: entry.content,
      completedAt: entry.timestamp,
      memoryText: entry.content,
      origin: USER_STATED_ORIGIN,
    });
    if (item === undefined) {
      throw new Error(`Entry ${entry.id} has nothing to save.`);
    }
    return item;
  }
  const date = mayaDate(entry.day);
  return noteRetainItem({
    sessionId: entry.session,
    turnId,
    completedAt: entry.timestamp,
    note: {
      source: entry.note_source,
      date,
      text: labeledNoteText({
        label: noteLabel({ source: entry.note_source, date, assistantName: MAYA_ASSISTANT_NAME }),
        text: entry.content,
      }),
    },
    documentId: `aman-${entry.session}-${turnId}-note`,
    chatReadNothing: false,
  });
}

/**
 * A hand edit as the vault shows it today: the person's own line on the page, with no marker. Nothing
 * else writes pages yet, so a page the person edits holds only what they typed.
 */
async function applyHandEdit({ vaultDir, event }: { vaultDir: string; event: MayaEvent }): Promise<void> {
  const page = mayaPageBySlug(event.about);
  if (page === undefined) {
    throw new Error(`No page in Maya's world has the slug ${event.about}.`);
  }
  const file = pagePath({ vaultDir, kind: page.kind, slug: event.about });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    [
      '---',
      `kind: ${page.kind}`,
      `title: ${page.title}`,
      '---',
      `# ${page.title}`,
      '',
      '## Now',
      `- ${event.after_line}`,
      '',
    ].join('\n'),
    'utf8',
  );
}

/**
 * The sorter runs one day behind: every note saved before `throughDay` has been handled by then, and the notes of
 * `throughDay` itself have not. A note whose expected decision puts something on a page is recorded as `page`; one
 * the pages take nothing from (`ignore`) is recorded as `none`.
 */
async function markEarlierNotesHandled({ dir, throughDay }: { dir: string; throughDay: number }): Promise<void> {
  const vaultDir = namespaceDirFor(dir, MAYA_NAMESPACE);
  const { entries } = await scanNamespaceEntries({
    baseDir: dir,
    namespace: MAYA_NAMESPACE,
    maxDailyFiles: Number.POSITIVE_INFINITY,
  });
  const texts = new Map(entries.map(entry => [entry.id, entry.text]));
  const handled = await readHandledNotes(vaultDir);
  for (let day = 1; day < throughDay; day += 1) {
    for (const [position, entry] of MAYA_ENTRIES.filter(candidate => candidate.day === day).entries()) {
      const noteId = `md:${MAYA_NAMESPACE}:${mayaDate(day)}.md#${String(position)}`;
      if (texts.get(noteId)?.includes(entry.content) !== true) {
        throw new Error(`Entry ${entry.id} is not where the vault keeps note ${noteId}.`);
      }
      if (!handled.has(noteId)) {
        const outcome = entry.expected.some(decision => decision.decision !== 'ignore') ? 'page' : 'none';
        await appendHandledNote({ vaultDir, noteId, outcome });
      }
    }
  }
}

/**
 * Writes days `fromDay` to `throughDay` of Maya's world into the vault under `dir`, through the same
 * writers the product uses. Call it again with the next range to move the world forward.
 *
 * With `sorted` false the only page is the one the person typed by hand. With `sorted` true the vault
 * instead holds the pages a perfect sorter would have written by the end of `throughDay`, and a list of the
 * notes it has handled, with what it did with each: those saved before `throughDay`.
 */
export async function buildMayaVault({
  dir,
  throughDay,
  fromDay = 1,
  sorted,
}: {
  dir: string;
  throughDay: number;
  fromDay?: number;
  sorted: boolean;
}): Promise<void> {
  const client = new MarkdownMemoryClient({ baseDir: dir, namespace: MAYA_NAMESPACE });
  for (let day = fromDay; day <= throughDay; day += 1) {
    const items = MAYA_ENTRIES.filter(entry => entry.day === day).map(retainItemOf);
    const outcome = await client.retain({ items, operationId: `maya-day-${String(day)}`, timeoutMs: 10_000 });
    if (!outcome.ok) {
      throw new Error(`Day ${String(day)} could not be written: ${outcome.reason ?? 'no reason was given'}`);
    }
    if (!sorted) {
      for (const event of MAYA_EVENTS.filter(candidate => candidate.day === day)) {
        await applyHandEdit({ vaultDir: namespaceDirFor(dir, MAYA_NAMESPACE), event });
      }
    }
  }
  if (sorted) {
    await writeMayaSortedPages({ vaultDir: namespaceDirFor(dir, MAYA_NAMESPACE), throughDay });
    await markEarlierNotesHandled({ dir, throughDay });
  }
}
