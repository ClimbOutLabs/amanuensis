import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  DAILY_LOG_FILE_PATTERN,
  dailyLogEntries,
  formatReviewedMark,
  latestTombstonesByEntry,
  namespaceDirFor,
  readReviewedMarks,
  readVaultTombstones,
  reviewableNoRecordChatId,
  REVIEWED_FROM_YOU_FILE,
  reviewedEntryHash,
  sanitizeNamespace,
  splitEntries,
  upgradeLegacyEntries,
  withSourceLines,
} from './markdownMemoryFiles';
import { replaceFile } from './vaultErase';
import { withVaultLock } from './vaultLock';

/** Records, in the memory folder, that the notes saved before entries named their source were marked. */
const STATE_FILE = '.source-lines.json';

/** Folder inside a vault that keeps each daily file as it was before it was marked. */
const ORIGINALS_DIR = '.before-source-lines';

const SourceLinesStateSchema = z.object({ done: z.literal(true) });

/** What the one-time marking of older notes did. */
export interface SourceLinesReport {
  filesChanged: number;
  notesMarked: number;
}

async function alreadyDone(baseDir: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(baseDir, STATE_FILE), 'utf8'));
    return SourceLinesStateSchema.safeParse(parsed).success;
  } catch {
    // No readable record means the work is still to do; doing it twice changes nothing.
    return false;
  }
}

async function vaultDirs(baseDir: string): Promise<string[]> {
  try {
    const found = await readdir(baseDir, { withFileTypes: true });
    return found.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name);
  } catch {
    // A memory folder that does not exist yet holds nothing to mark.
    return [];
  }
}

async function dailyFiles(dailyDir: string): Promise<string[]> {
  try {
    return (await readdir(dailyDir)).filter(name => DAILY_LOG_FILE_PATTERN.test(name)).sort();
  } catch {
    return [];
  }
}

/** Marks one daily file. The file as it was is kept first, and the new text replaces it in one step. */
async function markDailyFile(input: { vaultDir: string; file: string }): Promise<number> {
  const filePath = path.join(input.vaultDir, 'memory', input.file);
  const before = await readFile(filePath, 'utf8');
  const { content, marked } = withSourceLines(before);
  if (marked === 0) {
    return 0;
  }
  if (splitEntries(content).length !== splitEntries(upgradeLegacyEntries(before)).length) {
    throw new Error(`Marking ${filePath} would change how many notes it holds, so it was left as it is.`);
  }
  const originalsDir = path.join(input.vaultDir, ORIGINALS_DIR);
  await mkdir(originalsDir, { recursive: true });
  try {
    await copyFile(filePath, path.join(originalsDir, input.file), constants.COPYFILE_EXCL);
  } catch (error) {
    // A copy kept by an earlier, interrupted run is the true original and stays.
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error;
    }
  }
  await replaceFile({ file: filePath, content });
  return marked;
}

async function markAll(baseDir: string): Promise<SourceLinesReport | undefined> {
  if (await alreadyDone(baseDir)) {
    return undefined;
  }
  const report: SourceLinesReport = { filesChanged: 0, notesMarked: 0 };
  try {
    for (const vault of await vaultDirs(baseDir)) {
      const vaultDir = path.join(baseDir, vault);
      // One vault at a time, under the lock a save or an erase takes, so a rewrite never loses a note saved meanwhile.
      await withVaultLock({ vaultDir }, async () => {
        for (const file of await dailyFiles(path.join(vaultDir, 'memory'))) {
          const marked = await markDailyFile({ vaultDir, file });
          if (marked > 0) {
            report.filesChanged += 1;
            report.notesMarked += marked;
          }
        }
      });
    }
    await mkdir(baseDir, { recursive: true });
    await writeFile(path.join(baseDir, STATE_FILE), `${JSON.stringify({ done: true })}\n`, 'utf8');
  } catch (cause) {
    throw new Error(
      'Older memory notes could not be marked with where they came from. Check that Aman can write to its memory folder, then start Aman again.',
      { cause },
    );
  }
  return report;
}

const runs = new Map<string, Promise<SourceLinesReport | undefined>>();

/**
 * Makes sure every note saved before entries named their source carries a source line. It runs once
 * per memory folder, before the first note in today's form is written there: afterwards a closing
 * "From you" can only have been written by a save that knew the note was the person's own. The report
 * is undefined when an earlier start already did the work.
 */
export function ensureMemorySourceLines({ baseDir }: { baseDir: string }): Promise<SourceLinesReport | undefined> {
  const key = path.resolve(baseDir);
  const running = runs.get(key);
  if (running !== undefined) {
    return running;
  }
  const run = markAll(key).catch((error: unknown) => {
    // A failed run is tried again by the next caller instead of being remembered.
    runs.delete(key);
    throw error;
  });
  runs.set(key, run);
  return run;
}

/** Why a note was left as it is when its review was recorded. */
export type ReviewSkipReason = 'not_found' | 'not_reviewable' | 'edited_or_deleted' | 'already_reviewed';

export interface ReviewedNotesOutcome {
  recorded: string[];
  skipped: { entryId: string; reason: ReviewSkipReason }[];
}

const ENTRY_ID_PATTERN = /^md:([^:]+):(\d{4}-\d{2}-\d{2}\.md)#(\d+)$/;

/**
 * Records that the person reviewed these older notes and says they are their own. Nothing is rewritten:
 * one line per note is appended to the vault's reviewed-notes file, holding the note's id and the hash of
 * its text as stored. Readers hand a note on as "From you" only while its text still has that hash and
 * still closes with "External source: no record". A note that fails any check is skipped.
 * Only the review route calls this; the Memories edit path never does.
 */
export async function markReviewedNotesFromYou({
  baseDir,
  namespace,
  entryIds,
}: {
  baseDir: string;
  namespace: string;
  entryIds: readonly string[];
}): Promise<ReviewedNotesOutcome> {
  const safeNamespace = sanitizeNamespace(namespace);
  const dir = namespaceDirFor(baseDir, safeNamespace);
  const outcome: ReviewedNotesOutcome = { recorded: [], skipped: [] };
  const skip = (entryId: string, reason: ReviewSkipReason): void => {
    outcome.skipped.push({ entryId, reason });
  };
  const touched = latestTombstonesByEntry(await readVaultTombstones({ baseDir, namespace: safeNamespace }));
  const reviewed = await readReviewedMarks({ baseDir, namespace: safeNamespace });
  const entriesByFile = new Map<string, Map<string, string>>();
  const lines: string[] = [];
  for (const entryId of new Set(entryIds)) {
    const match = ENTRY_ID_PATTERN.exec(entryId);
    if (match?.[1] !== safeNamespace || match[2] === undefined) {
      skip(entryId, 'not_found');
      continue;
    }
    const file = match[2];
    let entries = entriesByFile.get(file);
    if (entries === undefined) {
      entries = new Map();
      try {
        const content = await readFile(path.join(dir, 'memory', file), 'utf8');
        for (const entry of dailyLogEntries({ safeNamespace, file, content })) {
          entries.set(entry.id, entry.text);
        }
      } catch {
        // A day file that cannot be read holds no note to review.
      }
      entriesByFile.set(file, entries);
    }
    const text = entries.get(entryId);
    // A deleted note is gone from its file, so the markers are asked first to say it was deleted.
    if (touched.has(entryId)) {
      skip(entryId, 'edited_or_deleted');
    } else if (text === undefined) {
      skip(entryId, 'not_found');
    } else if (reviewableNoRecordChatId(text) === undefined) {
      skip(entryId, 'not_reviewable');
    } else if (reviewed.get(entryId) === reviewedEntryHash(text)) {
      skip(entryId, 'already_reviewed');
    } else {
      lines.push(formatReviewedMark({ entryId, text }));
      outcome.recorded.push(entryId);
    }
  }
  if (lines.length > 0) {
    // One append, as the daily logs are written: it never rewrites what is there.
    await writeFile(path.join(dir, REVIEWED_FROM_YOU_FILE), `${lines.join('\n')}\n`, { flag: 'a', encoding: 'utf8' });
  }
  return outcome;
}
