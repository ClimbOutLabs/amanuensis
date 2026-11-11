/**
 * The list of daily-log notes the sorter has handled, and what it did with each: put its facts on a page, or
 * put nothing on any page. It is one file in the vault folder with `note id`, a tab and the outcome on each
 * line, only ever added to, so a missing file means nothing has been handled yet.
 */
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const HANDLED_NOTES_FILE = '.handled-notes';
const NOTE_ID_PATTERN = /^md:[^:\s]+:\d{4}-\d{2}-\d{2}\.md#\d+$/;

/** What the sorter did with a note: `page` put its facts on a page, `none` put nothing on any page. */
export const HandledOutcomeSchema = z.enum(['page', 'none']);
export type HandledOutcome = z.infer<typeof HandledOutcomeSchema>;

/**
 * The outcome of each handled note of this vault. A line with no outcome, an unknown outcome or an id that is not
 * a note id is skipped. A later line for the same note wins.
 */
export async function readHandledNotes(vaultDir: string): Promise<Map<string, HandledOutcome>> {
  const handled = new Map<string, HandledOutcome>();
  let content: string;
  try {
    content = await readFile(path.join(vaultDir, HANDLED_NOTES_FILE), 'utf8');
  } catch {
    return handled;
  }
  for (const line of content.split('\n')) {
    const [noteId, outcome, ...rest] = line.trim().split('\t');
    const parsed = HandledOutcomeSchema.safeParse(outcome);
    if (noteId !== undefined && rest.length === 0 && NOTE_ID_PATTERN.test(noteId) && parsed.success) {
      handled.set(noteId, parsed.data);
    }
  }
  return handled;
}

/** Records what the sorter did with one note. Something that is not a note id is not written. The leading line break keeps a write cut short earlier from joining this line to a torn one. */
export async function appendHandledNote({
  vaultDir,
  noteId,
  outcome,
}: {
  vaultDir: string;
  noteId: string;
  outcome: HandledOutcome;
}): Promise<void> {
  if (!NOTE_ID_PATTERN.test(noteId)) {
    return;
  }
  await appendFile(path.join(vaultDir, HANDLED_NOTES_FILE), `\n${noteId}\t${outcome}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}
