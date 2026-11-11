import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DAILY_LOG_FILE_PATTERN, splitEntries, upgradeLegacyEntries, withSourceLines } from './markdownMemoryFiles';

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
  const temporary = `${filePath}.source-lines.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, filePath);
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
      for (const file of await dailyFiles(path.join(vaultDir, 'memory'))) {
        const marked = await markDailyFile({ vaultDir, file });
        if (marked > 0) {
          report.filesChanged += 1;
          report.notesMarked += marked;
        }
      }
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
