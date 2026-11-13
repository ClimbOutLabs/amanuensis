/**
 * Nightly step 2: notes of the last 14 days that the sorter never handled are sorted now, oldest first, one at a
 * time. A note still counts as missed after a refused reply or a failed call, so a note that failed three nights
 * running is left alone, and three failures in a row end the step for the night.
 */
import { readHandledNotes } from './handledNotes';
import { entryRecallText, scanNamespaceEntries, type ScannedMemoryEntry } from './markdownMemoryFiles';
import type { PageListing } from './memoryPages';
import type { PageChangeOptions } from './memoryPageWriter';
import { changeNightlyState, readNightlyState } from './nightlyState';
import { sortNote, type SortModel } from './pageSorter';
import type { PageSortMode } from './pageSortMode';
import { readReportedNoteIds } from './pageSortReport';
import { noteOf } from './pageSortRun';

/** Notes older than this many days are left alone. */
export const MISSED_NOTES_WINDOW_DAYS = 14;

/** Most notes one run sorts. */
export const MISSED_NOTES_PER_RUN = 40;

const MAX_FAILED_NIGHTS = 3;
const MAX_FAILURES_IN_A_ROW = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOTE_FILE_DAY = /^(\d{4}-\d{2}-\d{2})\.md$/;

export interface MissedNotesResult {
  /** Notes the model was asked about. */
  asked: number;
  /** Notes whose reply was understood, written or only reported. */
  sorted: number;
}

function firstDayInWindow(today: string): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) - MISSED_NOTES_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
}

function inOrder(a: ScannedMemoryEntry, b: ScannedMemoryEntry): number {
  return a.file === b.file ? a.index - b.index : a.file < b.file ? -1 : 1;
}

/** Sorts the notes the sorter missed. With sorting `off` it does nothing. In `report` mode a note with a line in the report is not asked again. */
export async function sortMissedNotes({
  mode,
  baseDir,
  namespace,
  options,
  askModel,
  similarPages,
  countFailedNight,
}: {
  mode: PageSortMode;
  baseDir: string;
  /** The vault's folder name under `baseDir`. */
  namespace: string;
  options: PageChangeOptions;
  askModel: SortModel;
  similarPages: ((text: string) => Promise<PageListing[]>) | undefined;
  /** Whether a note that fails in this run moves one night closer to being left alone. */
  countFailedNight: boolean;
}): Promise<MissedNotesResult> {
  const result: MissedNotesResult = { asked: 0, sorted: 0 };
  if (mode === 'off') {
    return result;
  }
  const { vaultDir, today } = options;
  const since = firstDayInWindow(today);
  const { entries } = await scanNamespaceEntries({
    baseDir,
    namespace,
    maxDailyFiles: MISSED_NOTES_WINDOW_DAYS + 1,
    resolveTombstones: true,
  });
  const handled = await readHandledNotes(vaultDir);
  const reported = mode === 'report' ? await readReportedNoteIds(vaultDir) : new Set<string>();
  const { note_tries: tries } = await readNightlyState(vaultDir);
  const missed = entries
    .filter(entry => {
      const day = NOTE_FILE_DAY.exec(entry.file)?.[1];
      return (
        day !== undefined &&
        day >= since &&
        !handled.has(entry.id) &&
        !reported.has(entry.id) &&
        (tries[entry.id] ?? 0) < MAX_FAILED_NIGHTS &&
        entryRecallText(entry.text).trim() !== ''
      );
    })
    .sort(inOrder)
    .slice(0, MISSED_NOTES_PER_RUN);

  const failed = new Set<string>();
  let failuresInARow = 0;
  for (const entry of missed) {
    const outcome = await sortNote({
      mode,
      note: noteOf({ entry, today }),
      askModel,
      options,
      similarPages,
    });
    result.asked += 1;
    if (outcome.status === 'sorted') {
      result.sorted += 1;
      failuresInARow = 0;
      continue;
    }
    failed.add(entry.id);
    failuresInARow += 1;
    if (failuresInARow >= MAX_FAILURES_IN_A_ROW) {
      break;
    }
  }

  if (countFailedNight && (failed.size > 0 || Object.keys(tries).length > 0)) {
    const inWindow = new Set(entries.map(entry => entry.id));
    await changeNightlyState({
      vaultDir,
      change: state => {
        const counted: Record<string, number> = {};
        for (const id of inWindow) {
          const count = (state.note_tries[id] ?? 0) + (failed.has(id) ? 1 : 0);
          if (count > 0) {
            counted[id] = count;
          }
        }
        return { ...state, note_tries: counted };
      },
    });
  }
  return result;
}
