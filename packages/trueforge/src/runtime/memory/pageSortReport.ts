/**
 * The sorter's report mode leaves one JSON line per note in the vault folder: what it would have done, or why it
 * could not decide. It holds no text of the note. The file stays under a size cap by dropping its oldest lines.
 */
import { appendFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { SortDecisionSchema } from './pageSortDecisions';

export const SORT_REPORT_FILE = '.sorter-report.jsonl';

/** Largest the report may grow before its oldest lines are dropped. */
export const SORT_REPORT_MAX_BYTES = 256 * 1024;

export const SortReportLineSchema = z.strictObject({
  note_id: z.string(),
  day: z.string(),
  outcome: z.enum(['sorted', 'refused', 'failed']),
  /** The decisions after the host's rules; empty when the reply was refused or the call failed. */
  decisions: z.array(SortDecisionSchema),
  /** Why the reply was refused or the call failed. */
  reason: z.string().optional(),
});
export type SortReportLine = z.infer<typeof SortReportLineSchema>;

/** One writer at a time per file, so a trim never loses a line another note is adding. */
const writers = new Map<string, Promise<void>>();

async function replaceReport({ file, lines }: { file: string; lines: readonly string[] }): Promise<void> {
  const temp = `${file}.tmp`;
  try {
    await writeFile(temp, lines.length === 0 ? '' : `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function trimToCap(file: string): Promise<void> {
  if ((await stat(file)).size <= SORT_REPORT_MAX_BYTES) {
    return;
  }
  const lines = (await readFile(file, 'utf8')).split('\n').filter(line => line !== '');
  let size = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
  while (size > SORT_REPORT_MAX_BYTES && lines.length > 1) {
    const dropped = lines.shift();
    size -= Buffer.byteLength(dropped ?? '') + 1;
  }
  await replaceReport({ file, lines });
}

/** Runs one change to a vault's report after the ones already waiting. */
async function inTurn({ file, work }: { file: string; work: () => Promise<void> }): Promise<void> {
  const previous = writers.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  writers.set(file, next);
  try {
    await next;
  } finally {
    if (writers.get(file) === next) {
      writers.delete(file);
    }
  }
}

/** Adds one line to the vault's report. */
export async function appendSortReport({ vaultDir, line }: { vaultDir: string; line: SortReportLine }): Promise<void> {
  const file = path.join(vaultDir, SORT_REPORT_FILE);
  await inTurn({
    file,
    work: async () => {
      await appendFile(file, `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 });
      await trimToCap(file);
    },
  });
}

function noteIdOf(line: string): string | undefined {
  try {
    const parsed = z.object({ note_id: z.string() }).safeParse(JSON.parse(line));
    return parsed.success ? parsed.data.note_id : undefined;
  } catch {
    return undefined;
  }
}

/** The ids of the notes the report has a line for, whatever the line says. */
export async function readReportedNoteIds(vaultDir: string): Promise<Set<string>> {
  let text: string;
  try {
    text = await readFile(path.join(vaultDir, SORT_REPORT_FILE), 'utf8');
  } catch {
    return new Set();
  }
  const ids = new Set<string>();
  for (const line of text.split('\n')) {
    const id = noteIdOf(line);
    if (id !== undefined) {
      ids.add(id);
    }
  }
  return ids;
}

/**
 * Drops the report's lines about these notes. A decision can repeat a fact from its note, so a note the person
 * deletes or rewrites must not live on here.
 */
export async function forgetSortReport({
  vaultDir,
  noteIds,
}: {
  vaultDir: string;
  noteIds: readonly string[];
}): Promise<void> {
  const file = path.join(vaultDir, SORT_REPORT_FILE);
  const gone = new Set(noteIds);
  await inTurn({
    file,
    work: async () => {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (error) {
        if (z.object({ code: z.literal('ENOENT') }).safeParse(error).success) {
          return;
        }
        throw error;
      }
      const lines = text.split('\n').filter(line => line !== '');
      const kept = lines.filter(line => {
        const id = noteIdOf(line);
        return id === undefined || !gone.has(id);
      });
      if (kept.length !== lines.length) {
        await replaceReport({ file, lines: kept });
      }
    },
  });
}
